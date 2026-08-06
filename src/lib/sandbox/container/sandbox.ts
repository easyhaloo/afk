/**
 * Container sandbox — implements the Sandbox interface using a ContainerProvider.
 *
 * Per EXECUTION-DESIGN.md §6: "一次 workflow 一个 container，每次 context handoff
 * 只重启 Agent process". The sandbox owns the container lifecycle; AgentExecution
 * is the per-generation process inside it.
 *
 * Mount contract:
 *   <worktreePath>:/workspace                 (rw — agent writes code here)
 *   <afkSessionDir>:/afk/session              (rw — handoff docs, signal files)
 *   <afkResultDir>:/afk/result                (ro from agent POV — output capture)
 *
 * Forbidden mounts (enforced by CliContainerProvider): ~/.ssh, ~/.aws,
 * docker socket, sibling repos.
 *
 * Interrupt escalation chain (per design):
 *   interrupt()   -> SIGINT to container PID (graceful; agent flushes session)
 *   kill()        -> SIGKILL to container (force; session lost)
 *   close()       -> docker rm -f (terminal cleanup)
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { clearSignal, readSignal } from '../../io';
import type { Sandbox, SandboxOptions } from '../types';
import type {
  AgentStartOptions,
  AgentExecution,
  ExecutionEvent,
  ExecutionResult,
  InterruptReason,
  CaptureOptions,
  ResumeOptions,
} from '../types';
import type { ContainerProvider, ContainerExecResult } from './types';
import type { SessionSnapshot } from '../../agents/types';
import type { AgentProvider } from '../../agents/types';
import { EnvVarAllowlist } from './env-allowlist';

export class ContainerSandbox implements Sandbox {
  readonly id: string;
  readonly worktreePath: string;
  readonly workspacePath: string;
  private readonly containerName: string;
  private _containerId: string | null = null;
  private _closed = false;

  constructor(opts: {
    id?: string;
    worktreePath: string;
    image: string;
    user: string;
    containerName?: string;
    extraEnv?: Record<string, string>;
    extraAllowedEnv?: string[];
    workdir?: string;
    hostClaudeConfigDir?: string;
    hostClaudeConfigFile?: string;
  }) {
    this.id = opts.id ?? randomUUID();
    this.worktreePath = opts.worktreePath;
    this.workspacePath = '/workspace';
    this.containerName = opts.containerName ?? `afk-${this.id.slice(0, 8)}`;
    this._provider = undefined as unknown as ContainerProvider;
    this._image = opts.image;
    this._user = opts.user;
    this._extraEnv = opts.extraEnv ?? {};
    this._extraAllowedEnv = opts.extraAllowedEnv ?? [];
    this._workdir = opts.workdir ?? '/workspace';
    this._hostClaudeConfigDir = opts.hostClaudeConfigDir;
    this._hostClaudeConfigFile = opts.hostClaudeConfigFile;
  }

  // Configuration captured at construction. Provider is injected at create()
  // time so tests can swap it without subclassing.
  private _provider: ContainerProvider;
  private _image: string;
  private _user: string;
  private _extraEnv: Record<string, string>;
  private _extraAllowedEnv: string[];
  private _workdir: string;
  private _hostClaudeConfigDir?: string;
  private _hostClaudeConfigFile?: string;

  /** Bind the provider. Called by ContainerSandboxProvider.create(). */
  bindProvider(provider: ContainerProvider, image?: string, user?: string): void {
    this._provider = provider;
    if (image) this._image = image;
    if (user) this._user = user;
  }

  async startAgent(options: AgentStartOptions): Promise<AgentExecution> {
    if (this._closed) throw new Error('sandbox already closed');
    if (!this._containerId) {
      throw new Error('sandbox not created — call create() first');
    }
    if (options.executionMode && options.executionMode !== 'batch') {
      throw new Error('container sandbox supports batch execution only; use the local sandbox for interactive sessions');
    }
    const allow = new EnvVarAllowlist(this._extraAllowedEnv);
    const filtered = allow.filter({ ...this._extraEnv, ...options.command.env });

    const executionId = randomUUID();
    const promptPath = join(this.worktreePath, '.afk', 'session', `${executionId}.prompt`);
    const outputPath = join(this.worktreePath, '.afk', 'result', `${executionId}.stdout`);
    const errorPath = join(this.worktreePath, '.afk', 'result', `${executionId}.stderr`);
    const exitPath = join(this.worktreePath, '.afk', 'result', `${executionId}.exit`);
    await Promise.all([
      clearSignal(this.worktreePath),
      fs.writeFile(promptPath, `${options.prompt}\n`, 'utf-8'),
      fs.rm(outputPath, { force: true }),
      fs.rm(errorPath, { force: true }),
      fs.rm(exitPath, { force: true }),
    ]);

    const resultBase = '/afk/result';
    const promptInContainer = `/afk/session/${executionId}.prompt`;
    const outputInContainer = `${resultBase}/${executionId}.stdout`;
    const errorInContainer = `${resultBase}/${executionId}.stderr`;
    const exitInContainer = `${resultBase}/${executionId}.exit`;
    const script = [
      'prompt="$1"',
      'shift',
      'set +e',
      `"$@" < "$prompt" > '${outputInContainer}' 2> '${errorInContainer}'`,
      'code=$?',
      `printf '%s\\n' "$code" > '${exitInContainer}'`,
      'exit 0',
    ].join('; ');
    const argv = ['sh', '-c', script, 'afk-container-agent', promptInContainer, ...options.command.argv];
    const execResult: ContainerExecResult = await this._provider.exec({
      containerId: this._containerId,
      command: argv,
      env: filtered.allowed,
      workdir: this._workdir,
      detach: true,
    });

    const execution = new ContainerAgentExecution({
      provider: this._provider,
      containerId: this._containerId,
      worktreePath: this.worktreePath,
      sessionName: this.containerName,
      generation: options.generation,
      signalType: options.signalType,
      execId: execResult.execId,
      outputPath,
      errorPath,
      exitPath,
      agentProvider: options.agentProvider,
    });
    await execution.sendPrompt();
    return execution;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    if (this._containerId) {
      try {
        await this._provider.killContainer(this._containerId, 'SIGKILL');
      } catch { /* already dead */ }
      try {
        await this._provider.remove(this._containerId, true);
      } catch { /* already gone */ }
    }
  }

  /**
   * Internal: build the validated ContainerCreateOptions and call provider.create().
   * Called by ContainerSandboxProvider.create(); not part of the Sandbox interface.
   */
  async createContainer(): Promise<void> {
    const afkSessionDir = join(this.worktreePath, '.afk', 'session');
    const afkResultDir = join(this.worktreePath, '.afk', 'result');
    await fs.mkdir(afkSessionDir, { recursive: true });
    await fs.mkdir(afkResultDir, { recursive: true });

    const handle = await this._provider.create({
      image: this._image,
      name: this.containerName,
      user: this._user,
      mounts: [
        { hostPath: this.worktreePath, containerPath: '/workspace' },
        { hostPath: afkSessionDir, containerPath: '/afk/session' },
        { hostPath: afkResultDir, containerPath: '/afk/result' },
        ...(this._hostClaudeConfigDir
          ? [{ hostPath: this._hostClaudeConfigDir, containerPath: '/home/node/.claude', readOnly: true }]
          : []),
        ...(this._hostClaudeConfigFile
          ? [{ hostPath: this._hostClaudeConfigFile, containerPath: '/home/node/.claude.json', readOnly: true }]
          : []),
      ],
      env: this._extraEnv,
      // PID 1 sleeps forever so the container stays alive across agent
      // process restarts (every context handoff re-execs the agent).
      command: ['sleep', 'infinity'],
      dropCapabilities: ['ALL'],
      workdir: this._workdir,
    });
    this._containerId = handle.id;
  }
}

/**
 * AgentExecution inside a ContainerSandbox. Wraps a single exec session
 * with the container's interrupt escalation chain.
 */
export class ContainerAgentExecution implements AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  private readonly worktreePath: string;
  private readonly signalType: 'goal_complete';
  private readonly generation: number;
  private readonly outputPath: string;
  private readonly errorPath: string;
  private readonly exitPath: string;
  private readonly agentProvider?: AgentProvider;
  private _interruptAcked = false;
  private _done = false;

  constructor(opts: {
    provider: ContainerProvider;
    containerId: string;
    worktreePath: string;
    sessionName: string;
    generation: number;
    signalType: 'goal_complete';
    execId: string;
    outputPath: string;
    errorPath: string;
    exitPath: string;
    agentProvider?: AgentProvider;
  }) {
    this.id = opts.execId;
    this.sessionId = opts.sessionName;
    this.worktreePath = opts.worktreePath;
    this.signalType = opts.signalType;
    this.generation = opts.generation;
    this._provider = opts.provider;
    this._containerId = opts.containerId;
    this.outputPath = opts.outputPath;
    this.errorPath = opts.errorPath;
    this.exitPath = opts.exitPath;
    this.agentProvider = opts.agentProvider;
  }

  private _provider: ContainerProvider;
  private _containerId: string;

  /**
   * Send the goal to the in-container agent by writing it to /afk/session/goal.txt
   * (the agent process inside the container watches this file). This mirrors the
   * local tmux.sendPrompt() pattern but goes through the bind-mounted session dir.
   */
  async sendPrompt(): Promise<void> {
    // Caller responsibility: agent command itself consumes stdin/argv.
    // For now the goal text is delivered via the agent argv (--prompt or
    // equivalent). Future: write to goal.txt via container exec.
    this._interruptAcked = false;
  }

  async waitForEvent(): Promise<ExecutionEvent | null> {
    // Streaming exec is Phase 7/8; this returns null until then.
    return null;
  }

  async waitForResult(options?: { completionTimeoutMs?: number; contextHighTokens?: number }): Promise<ExecutionResult> {
    const timeout = options?.completionTimeoutMs ?? 600_000;
    const startedAt = Date.now();
    while (true) {
      if (this._interruptAcked) return this.result('aborted');
      if (Date.now() - startedAt >= timeout) {
        await this.kill();
        return this.result('timed_out');
      }

      const signal = await readSignal(this.worktreePath).catch(() => undefined);
      if (signal?.type === this.signalType) {
        this._done = true;
        return this.result('completed', { structuredOutput: signal });
      }

      const exitCode = await readExitCode(this.exitPath);
      if (exitCode !== undefined) {
        this._done = true;
        const [stdout, stderr] = await Promise.all([readOptional(this.outputPath), readOptional(this.errorPath)]);
        const structuredOutput = this.readStructuredOutput(stdout ?? '');
        if (exitCode !== 0) {
          return this.result('failed', {
            exitCode,
            error: { code: 'NON_ZERO_EXIT', message: stderr?.trim() || stdout?.trim() || `process exited with code ${exitCode}` },
          });
        }
        if (structuredOutput && typeof structuredOutput === 'object' && (structuredOutput as { type?: unknown }).type === this.signalType) {
          return this.result('completed', { exitCode, structuredOutput });
        }
        return this.result('failed', {
          exitCode,
          error: { code: 'MISSING_RESULT', message: `container execution ended without ${this.signalType} result` },
        });
      }
      await sleep(200);
    }
  }

  /** Send SIGINT (graceful) — agent flushes its session before exiting. */
  async interrupt(_reason: InterruptReason): Promise<void> {
    if (this._done) return;
    try {
      await this._provider.killContainer(this._containerId, 'SIGINT');
      this._interruptAcked = true;
    } catch {
      this._done = true;
    }
  }

  /** Force-kill the agent process group (SIGKILL). Session state NOT preserved. */
  async kill(): Promise<void> {
    if (this._done) return;
    this._done = true;
    try {
      await this._provider.killContainer(this._containerId, 'SIGKILL');
    } catch { /* ignore */ }
  }

  async captureOutput(_options?: CaptureOptions): Promise<string> {
    const [stdout, stderr] = await Promise.all([readOptional(this.outputPath), readOptional(this.errorPath)]);
    return [stdout, stderr].filter(Boolean).join('\n');
  }

  async captureSession(): Promise<SessionSnapshot | undefined> {
    return undefined;
  }

  async resume(_options: ResumeOptions): Promise<AgentExecution> {
    // Phase 7/8: re-exec the agent inside the same container with handoff doc.
    throw new Error('ContainerAgentExecution.resume not yet implemented');
  }

  private result(status: ExecutionResult['status'], extra: Partial<ExecutionResult> = {}): ExecutionResult {
    return {
      version: 1,
      runId: this.id,
      status,
      provider: 'container',
      sessionId: this.sessionId,
      commits: [],
      ...extra,
    };
  }

  private readStructuredOutput(stdout: string): unknown {
    for (const line of stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const events = this.agentProvider?.parseLine?.(line) ?? [];
      for (const event of events) {
        if (event.type !== 'result') continue;
        const parsed = parseGoalComplete(String(event.result ?? ''));
        if (parsed) return parsed;
      }
      const parsed = parseGoalComplete(line);
      if (parsed) return parsed;
    }
    return undefined;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readExitCode(path: string): Promise<number | undefined> {
  const raw = await readOptional(path);
  if (raw === undefined) return undefined;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function parseGoalComplete(value: string): unknown {
  const match = value.match(/<goal_complete>([\s\S]*?)<\/goal_complete>/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[1]);
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Convenience: build a ContainerSandbox from SandboxOptions. Used by
 *  ContainerSandboxProvider.create() and by tests. */
export function buildContainerSandboxOptions(
  sandboxOptions: SandboxOptions,
  image: string,
  user: string,
): { worktreePath: string; image: string; user: string } {
  return { worktreePath: sandboxOptions.worktreePath, image, user };
}
