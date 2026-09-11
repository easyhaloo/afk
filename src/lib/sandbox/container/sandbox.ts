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
  }

  // Configuration captured at construction. Provider is injected at create()
  // time so tests can swap it without subclassing.
  private _provider: ContainerProvider;
  private _image: string;
  private _user: string;
  private _extraEnv: Record<string, string>;
  private _extraAllowedEnv: string[];
  private _workdir: string;

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
    const allow = new EnvVarAllowlist(this._extraAllowedEnv);
    const filtered = allow.filter({ ...this._extraEnv, ...options.command.env });

    // Build the in-container command: argv from the agent provider, with env
    // passed via `docker exec -e`. cwd is /workspace.
    const argv = [...options.command.argv];
    const execResult: ContainerExecResult = await this._provider.exec({
      containerId: this._containerId,
      command: argv,
      env: filtered.allowed,
      workdir: this._workdir,
    });

    const execution = new ContainerAgentExecution({
      provider: this._provider,
      containerId: this._containerId,
      worktreePath: this.worktreePath,
      sessionName: this.containerName,
      generation: options.generation,
      signalType: options.signalType,
      execId: execResult.execId,
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
  }) {
    this.id = opts.execId;
    this.sessionId = opts.sessionName;
    this.worktreePath = opts.worktreePath;
    this.signalType = opts.signalType;
    this.generation = opts.generation;
    this._provider = opts.provider;
    this._containerId = opts.containerId;
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

  async waitForResult(_options?: { completionTimeoutMs?: number; contextHighTokens?: number }): Promise<ExecutionResult> {
    // Container execution result depends on the same signal-file polling as
    // LocalAgentExecution; full implementation will delegate to the signal
    // file in the bind-mounted session dir. For now return a stub.
    return {
      version: 1,
      runId: this.id,
      status: this._interruptAcked ? 'aborted' : 'failed',
      provider: 'container',
      sessionId: this.sessionId,
      commits: [],
    };
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
    // TODO Phase 7/8: docker logs <container> --tail N
    return '';
  }

  async captureSession(): Promise<SessionSnapshot | undefined> {
    return undefined;
  }

  async resume(_options: ResumeOptions): Promise<AgentExecution> {
    // Phase 7/8: re-exec the agent inside the same container with handoff doc.
    throw new Error('ContainerAgentExecution.resume not yet implemented');
  }
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
