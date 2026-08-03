/**
 * Batch-mode agent execution — streams and parses stdout for structured output.
 *
 * Per ADR-0014, batch mode uses `--print --output-format stream-json` and parses
 * the stdout event stream directly, rather than relying on tmux + signal file polling.
 *
 * The execution:
 * 1. Spawns the agent as a detached child process (no tmux)
 * 2. Collects and parses stdout line-by-line as stream-json events
 * 3. Emits ExecutionEvents for usage/result/error as they arrive
 * 4. Returns ExecutionResult when goal_complete/ac_result is detected
 *
 * Unlike LocalAgentExecution (interactive mode), this class does NOT use tmux
 * or signal files — completion is detected purely via the stream-json output.
 */

import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type {
  AgentProvider,
  AgentCommand,
  TokenUsage,
  SessionSnapshot,
} from '../../../lib/agents/types';
import type {
  AgentExecution,
  ExecutionEvent,
  ExecutionResult,
  InterruptReason,
  CaptureOptions,
  ResumeOptions,
} from '../types';

export class StreamingAgentExecution implements AgentExecution {
  readonly id: string;
  readonly sessionId?: string;

  private readonly command: AgentCommand;
  private readonly prompt: string;
  private readonly signalType: 'goal_complete' | 'ac_result';
  private readonly worktreePath: string;
  private readonly agentProvider?: AgentProvider;

  private proc: ChildProcess | null = null;
  private done = false;
  private interruptAcked = false;
  private exitCode: number | undefined;
  private error: ExecutionResult['error'] | undefined;
  private structuredOutput: unknown;
  private usage: TokenUsage | undefined;

  constructor(opts: {
    command: AgentCommand;
    prompt: string;
    signalType: 'goal_complete' | 'ac_result';
    worktreePath: string;
    sessionId?: string;
    agentProvider?: AgentProvider;
  }) {
    this.id = randomUUID();
    this.sessionId = opts.sessionId;
    this.command = opts.command;
    this.prompt = opts.prompt;
    this.signalType = opts.signalType;
    this.worktreePath = opts.worktreePath;
    this.agentProvider = opts.agentProvider;
  }

  /**
   * Spawn the agent process and start streaming stdout.
   * Called by Sandbox.startAgent(); do not call twice.
   */
  start(): void {
    if (this.proc) return;

    // prompt already contains the `/goal ` prefix (from the template).
    const argv = this.command.argv;

    this.proc = spawn(this.command.argv[0]!, this.command.argv.slice(1), {
      cwd: this.command.cwd ?? this.worktreePath,
      env: { ...process.env, ...this.command.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });

    // Send prompt via stdin
    if (this.proc.stdin) {
      this.proc.stdin.write(`${this.prompt}\n`);
      this.proc.stdin.end();
    }

    if (this.proc.stdout) {
      this.proc.stdout.on('data', (chunk: Buffer) => {
        const lines = chunk.toString('utf-8').split('\n');
        for (const line of lines) {
          if (line.trim()) this.handleLine(line);
        }
      });
    }

    if (this.proc.stderr) {
      this.proc.stderr.on('data', (chunk: Buffer) => {
        // Stream-json errors may appear on stderr; treat as text events
        const text = chunk.toString('utf-8').trim();
        if (text) {
          // pass through — runner may surface these
        }
      });
    }

    this.proc.on('exit', (code, signal) => {
      this.exitCode = code ?? undefined;
      if (signal) {
        this.error = { code: signal, message: `Process killed by ${signal}` };
      }
      this.done = true;
    });

    this.proc.on('error', (err: Error) => {
      this.error = { code: 'SPAWN_ERROR', message: err.message };
      this.done = true;
    });
  }

  /**
   * Parse a single line of stream-json output.
   *
   * Delegates to AgentProvider.parseLine() for generic event parsing (usage/error/result).
   * Only the AFK-specific signal wrapping (<goal_complete>...</goal_complete>) is handled
   * locally, keeping the provider free of AFK protocol knowledge.
   */
  private handleLine(line: string): void {
    if (this.done) return;

    // Try provider.parseLine first (provider-specific stream-json format)
    if (this.agentProvider?.parseLine) {
      const events = this.agentProvider.parseLine(line);
      for (const event of events) {
        switch (event.type) {
          case 'usage':
            this.usage = event.usage;
            break;
          case 'error':
            this.error = {
              code: 'AGENT_ERROR',
              message: event.error.message,
            };
            break;
          case 'result': {
            // result field contains raw output: <goal_complete>{"summary":"..."}</goal_complete>
            const raw = String(event.result ?? '');
            const extracted = this.extractSignal(raw);
            if (extracted) {
              this.structuredOutput = extracted;
              this.done = true;
            }
            break;
          }
          case 'text':
            // progress text — ignored
            break;
          default:
            break;
        }
      }
      return;
    }

    // Fallback: inline parsing if provider has no parseLine
    let parsed: { type: string; [key: string]: unknown };
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    switch (parsed.type) {
      case 'usage':
        this.usage = parsed.usage as TokenUsage;
        break;
      case 'result': {
        const raw = String(parsed.result ?? '');
        const extracted = this.extractSignal(raw);
        if (extracted) {
          this.structuredOutput = extracted;
          this.done = true;
        }
        break;
      }
      case 'error':
        this.error = {
          code: String(parsed.code ?? 'UNKNOWN'),
          message: String(parsed.message ?? parsed.error ?? 'Unknown error'),
        };
        break;
      default:
        break;
    }
  }

  /**
   * Extract signal from raw result text.
   * Handles both wrapped format: <goal_complete>{...}</goal_complete>
   * and bare JSON for handoff_ready.
   *
   * The canonical signal type comes from the JSON payload's "type" field.
   * The wrapping tag is used only as a delimiter; if JSON parsing fails
   * the raw trimmed text is returned as a bare result.
   */
  private extractSignal(raw: string): unknown {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;

    // Try wrapped format: <goal_complete>{...}</goal_complete>
    const wrapped = trimmed.match(/^<(\w+)>(.+)<\/\1>$/s);
    if (wrapped) {
      const [, wrapperTag, json] = wrapped;
      let data: unknown;
      try {
        data = JSON.parse(json);
      } catch {
        // Malformed JSON — fall through to bare result
        data = null;
      }
      // Prefer payload type; fall back to wrapper tag only if payload has no type
      if (data && typeof data === 'object' && 'type' in data) {
        return data;
      }
      // Malformed or no type — return null so caller treats as unknown result
      return null;
    }

    // Try bare JSON (e.g., handoff_ready)
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  async waitForEvent(): Promise<ExecutionEvent | null> {
    // StreamingAgentExecution is single-shot; events are consumed inline via handleLine.
    // This method returns null since the stream is not exposed as an async iterator.
    return null;
  }

  async waitForResult(options?: {
    completionTimeoutMs?: number;
    contextHighTokens?: number;
  }): Promise<ExecutionResult> {
    const completionTimeoutMs = options?.completionTimeoutMs ?? 600_000;
    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.done) break;
      if (Date.now() - start >= completionTimeoutMs) {
        this.kill();
        return {
          version: 1,
          runId: this.id,
          status: 'timed_out',
          provider: 'batch',
          sessionId: this.sessionId,
          commits: [],
        };
      }
      await this.sleep(500);
    }

    // Determine final status
    if (this.interruptAcked) {
      return {
        version: 1,
        runId: this.id,
        status: 'aborted',
        provider: 'batch',
        sessionId: this.sessionId,
        usage: this.usage,
        commits: [],
      };
    }

    if (this.error) {
      // If we already detected a result (goal_complete), prefer completed over failed
      if (this.structuredOutput) {
        return {
          version: 1,
          runId: this.id,
          status: 'completed',
          provider: 'batch',
          sessionId: this.sessionId,
          exitCode: this.exitCode,
          structuredOutput: this.structuredOutput,
          usage: this.usage,
          commits: [],
        };
      }
      return {
        version: 1,
        runId: this.id,
        status: 'failed',
        provider: 'batch',
        sessionId: this.sessionId,
        exitCode: this.exitCode,
        error: this.error,
        usage: this.usage,
        commits: [],
      };
    }

    return {
      version: 1,
      runId: this.id,
      status: 'completed',
      provider: 'batch',
      sessionId: this.sessionId,
      exitCode: this.exitCode,
      structuredOutput: this.structuredOutput,
      usage: this.usage,
      commits: [],
    };
  }

  async interrupt(_reason: InterruptReason): Promise<void> {
    if (this.done) return;
    try {
      this.proc?.kill('SIGINT');
      this.interruptAcked = true;
      this.done = true;
    } catch {
      this.interruptAcked = true;
      this.done = true;
    }
  }

  async kill(): Promise<void> {
    if (this.done) return;
    this.done = true;
    try {
      this.proc?.kill('SIGKILL');
    } catch { /* ignore */ }
  }

  async captureOutput(_options?: CaptureOptions): Promise<string> {
    // Batch mode stdout is not buffered — no capturable pane output
    return '';
  }

  async captureSession(): Promise<SessionSnapshot | undefined> {
    return undefined;
  }

  async resume(_options: ResumeOptions): Promise<AgentExecution> {
    throw new Error('StreamingAgentExecution.resume not yet implemented');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
