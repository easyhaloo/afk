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
 * 4. Returns ExecutionResult when goal_complete is detected
 *
 * Unlike LocalAgentExecution (interactive mode), this class does NOT use tmux
 * or signal files — completion is detected purely via the stream-json output.
 */

import { execFileSync, spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import type {
  AgentCommand,
  AgentEvent,
  AgentExecutionMetadata,
  TokenUsage,
  SessionSnapshot,
} from '../../../domain/agents/types';
import type {
  AgentExecution,
  ExecutionEvent,
  ExecutionResult,
  InterruptReason,
  CaptureOptions,
  ResumeOptions,
} from '../types';
import { extractGoalComplete } from '../../../shared/goal-complete';

export class StreamingAgentExecution implements AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  readonly metadata: AgentExecutionMetadata;

  private readonly command: AgentCommand;
  private readonly prompt: string;
  private readonly signalType: 'goal_complete';
  private readonly worktreePath: string;
  private readonly parseLine?: (line: string) => AgentEvent[];

  private proc: ChildProcess | null = null;
  private done = false;
  private interruptAcked = false;
  private exitCode: number | undefined;
  private error: ExecutionResult['error'] | undefined;
  private structuredOutput: unknown;
  private usage: TokenUsage | undefined;
  private stdoutBuffer = '';
  private stdoutTail = '';
  private stderrBuffer = '';
  private lastResultOutput = '';

  constructor(opts: {
    command: AgentCommand;
    prompt: string;
    signalType: 'goal_complete';
    worktreePath: string;
    sessionId?: string;
    metadata: AgentExecutionMetadata;
    parseLine?: (line: string) => AgentEvent[];
  }) {
    this.id = randomUUID();
    this.sessionId = opts.sessionId;
    this.metadata = opts.metadata;
    this.command = opts.command;
    this.prompt = opts.prompt;
    this.signalType = opts.signalType;
    this.worktreePath = opts.worktreePath;
    this.parseLine = opts.parseLine;
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
      // A provider command may be a shell wrapper (Claude's macOS shim is one)
      // and can spawn a real agent child. Put the whole tree in one process
      // group so timeout/interrupt cleanup cannot leave the agent orphaned.
      detached: process.platform !== 'win32',
    });

    // Send prompt via stdin
    if (this.proc.stdin) {
      this.proc.stdin.write(`${this.prompt}\n`);
      this.proc.stdin.end();
    }

    if (this.proc.stdout) {
      this.proc.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        this.stdoutBuffer += text;
        this.stdoutTail = (this.stdoutTail + text).slice(-4000);
        this.drainStdoutLines();
        this.completeFromBufferedSignal();
      });
    }

    if (this.proc.stderr) {
      this.proc.stderr.on('data', (chunk: Buffer) => {
        // Stream-json errors may appear on stderr; treat as text events
        this.stderrBuffer += chunk.toString('utf-8');
      });
    }

    this.proc.on('exit', (code, signal) => {
      if (this.stdoutBuffer.trim()) this.handleLine(this.stdoutBuffer);
      this.stdoutBuffer = '';
      this.exitCode = code ?? undefined;
      if (signal) {
        this.error = { code: signal, message: `Process killed by ${signal}` };
      } else if (code !== 0) {
        this.error = {
          code: 'NON_ZERO_EXIT',
          message: this.stderrBuffer.trim() || this.stdoutTail.trim() || `Process exited with code ${code}`,
        };
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
   * Delegates to the provider-neutral parser for generic events.
   * Only the AFK-specific signal wrapping (<goal_complete>...</goal_complete>) is handled
   * locally, keeping the provider free of AFK protocol knowledge.
   */
  private handleLine(line: string): void {
    if (this.done) return;

    if (this.parseLine) {
      const events = this.parseLine(line);
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
            this.lastResultOutput = raw.trim().slice(-4000);
            const extracted = this.extractSignal(raw);
            if (extracted) {
              this.structuredOutput = extracted;
              if (this.hasExpectedSignal()) this.done = true;
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
        this.lastResultOutput = raw.trim().slice(-4000);
        const extracted = this.extractSignal(raw);
        if (extracted) {
          this.structuredOutput = extracted;
          if (this.hasExpectedSignal()) this.done = true;
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
    const completion = extractGoalComplete(trimmed);
    if (completion) return completion;

    // Try bare JSON (e.g., handoff_ready)
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  private hasExpectedSignal(): boolean {
    if (!this.structuredOutput || typeof this.structuredOutput !== 'object') return false;
    return (this.structuredOutput as { type?: unknown }).type === this.signalType;
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

    if (this.error || (this.exitCode !== undefined && this.exitCode !== 0)) {
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

    if (!this.structuredOutput || !this.hasExpectedSignal()) {
      return {
        version: 1,
        runId: this.id,
        status: 'failed',
        provider: 'batch',
        sessionId: this.sessionId,
        exitCode: this.exitCode,
        error: {
          code: 'MISSING_RESULT',
          message: `batch execution ended without ${this.signalType} result${this.lastResultOutput ? `; lastResult=${this.lastResultOutput}` : ''}`,
        },
        usage: this.usage,
        commits: [],
      };
    }

    const completed: ExecutionResult = {
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
    this.terminateProcess();
    return completed;
  }

  async interrupt(_reason: InterruptReason): Promise<void> {
    if (this.done) return;
    try {
      this.signalProcess('SIGINT');
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
      this.signalProcess('SIGKILL');
    } catch { /* ignore */ }
  }

  async captureOutput(_options?: CaptureOptions): Promise<string> {
    // Keep the bounded stream tail available to the runtime diagnostics store.
    return [this.stdoutTail, this.stderrBuffer].filter(Boolean).join('\n');
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

  private drainStdoutLines(): void {
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
    }
  }

  private completeFromBufferedSignal(): void {
    if (this.done) return;
    try {
      JSON.parse(this.stdoutBuffer);
      this.handleLine(this.stdoutBuffer);
      if (this.done) return;
    } catch {
      // The buffer may instead contain a provider's raw completion marker.
    }
    const extracted = extractGoalComplete(this.stdoutBuffer);
    if (!extracted) return;
    this.structuredOutput = extracted;
    if (this.hasExpectedSignal()) this.done = true;
  }

  private terminateProcess(): void {
    if (this.exitCode !== undefined) return;
    try {
      this.signalProcess('SIGKILL');
    } catch { /* process already exited */ }
  }

  private signalProcess(signal: NodeJS.Signals): void {
    const pid = this.proc?.pid;
    if (!pid) return;

    // Claude may start shell commands in their own process groups. Capture
    // descendants before signalling the agent group so they cannot be orphaned.
    const descendants = this.findDescendantPids(pid);
    for (const descendant of descendants) {
      try {
        process.kill(descendant, signal);
      } catch { /* process already exited */ }
    }
    if (process.platform !== 'win32') {
      try {
        process.kill(-pid, signal);
        return;
      } catch {
        // Fall back to the direct child when the group has already exited.
      }
    }
    this.proc?.kill(signal);
  }

  private findDescendantPids(rootPid: number): number[] {
    if (process.platform === 'win32') return [];

    try {
      const output = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' });
      const children = new Map<number, number[]>();
      for (const line of output.split('\n')) {
        const [pidText, parentText] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const parent = Number(parentText);
        if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue;
        const siblings = children.get(parent) ?? [];
        siblings.push(pid);
        children.set(parent, siblings);
      }

      const descendants: number[] = [];
      const visit = (parent: number): void => {
        for (const child of children.get(parent) ?? []) {
          visit(child);
          descendants.push(child);
        }
      };
      visit(rootPid);
      return descendants;
    } catch {
      return [];
    }
  }
}
