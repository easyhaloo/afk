/**
 * Local sandbox provider — wraps git worktree + tmux as a unified Sandbox.
 *
 * Implements the SandboxProvider interface using existing WorktreeManager and
 * TmuxClient components without changing their behavior.
 *
 * Responsibilities:
 * - SandboxProvider.createWorktree() → creates git worktree via WorktreeManager
 * - SandboxProvider.create() → creates tmux session in existing worktree
 * - Sandbox.startAgent() → launches agent via tmux.sendPrompt
 * - AgentExecution → wraps tmux session lifecycle with ExecutionResult
 *
 * Does NOT manage lifecycle modules (isolate, etc.) — those are runner-owned.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { join } from 'path';
import { WorktreeManager } from '../../git/index';
import { TmuxClient } from '../../tmux/tmux';
import { clearSignal, getTokenUsage, readSignal } from '../../io';
import { StreamingAgentExecution } from './streaming';
import {
  type SandboxProvider,
  type Sandbox,
  type SandboxOptions,
  type SandboxCapability,
  type AgentStartOptions,
  type AgentExecution,
  type ExecutionEvent,
  type ExecutionResult,
  type InterruptReason,
  type CaptureOptions,
  type ResumeOptions,
  type SandboxProviderName,
  type IsolationLevel,
  type WorktreeInfo,
} from '../types';
import type { AgentCommand, SessionSnapshot } from '../../../domain/agents/types';

const SANDBOX_CAPABILITIES: ReadonlySet<SandboxCapability> = new Set([
  'streaming-exec',
  'interrupt-process',
  'kill-process',
  'persistent-filesystem',
  'copy-files',
  'session-transfer',
] as const);

const ISOLATION_LEVEL: IsolationLevel = 'workspace';

/**
 * Local sandbox backed by git worktree + tmux.
 *
 * Wraps WorktreeManager and TmuxClient. Does NOT own the WorktreeManager
 * lifecycle (that is runner-owned via lifecycle hooks) — only manages
 * the tmux session within an existing worktree.
 */
export class LocalSandbox implements Sandbox {
  readonly id: string;
  readonly worktreePath: string;
  readonly workspacePath: string;
  private readonly tmux: TmuxClient;
  private readonly sessionName: string;
  private readonly branch?: string;
  private _closed = false;
  private sessionCreated = false;

  constructor(opts: {
    id: string;
    worktreePath: string;
    sessionName: string;
    branch?: string;
    tmux?: TmuxClient;
  }) {
    this.id = opts.id;
    this.worktreePath = opts.worktreePath;
    this.workspacePath = opts.worktreePath; // local: workspace == worktree
    this.tmux = opts.tmux as TmuxClient;
    this.sessionName = opts.sessionName;
    this.branch = opts.branch;
  }

  async startAgent(options: AgentStartOptions): Promise<AgentExecution> {
    if (this._closed) throw new Error('sandbox already closed');

    // Batch mode: spawn child process directly, parse stream-json stdout.
    // No tmux involvement; StreamingAgentExecution manages its own process.
    if (options.executionMode === 'batch') {
      const execution = new StreamingAgentExecution({
        command: options.command,
        prompt: options.prompt,
        signalType: options.signalType,
        worktreePath: this.worktreePath,
        sessionId: this.sessionName,
        agentProvider: options.agentProvider,
      });
      execution.start();
      return execution;
    }

    if (options.executionMode !== 'interactive') throw new Error('execution mode is required');
    if (!this.tmux) throw new Error('interactive local execution requires tmux');
    await clearSignal(this.worktreePath);
    if (!this.sessionCreated) {
      // The marker belongs to a Claude process, not the worktree. A prior
      // phase's file must not make a freshly-created tmux session look ready.
      await fs.unlink(join(this.worktreePath, '.afk', 'claude-status.json')).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
      await this.tmux.createSession(this.sessionName, this.worktreePath, options.command.argv.map(shellQuote).join(' '));
      this.sessionCreated = true;
    }

    // Interactive mode (default): use tmux session to drive the agent.
    const execution = new LocalAgentExecution({
      worktreePath: this.worktreePath,
      sessionName: this.sessionName,
      command: options.command,
      generation: options.generation,
      prompt: options.prompt,
      signalType: options.signalType,
      tmux: this.tmux,
    });
    await execution.sendPrompt();
    return execution;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try {
      await this.tmux.killSession(this.sessionName);
    } catch { /* ignore if session already gone */ }
    try {
      await this.tmux.closeSession();
    } catch { /* ignore */ }
  }
}

/**
 * Execution inside a LocalSandbox — wraps tmux session operations.
 *
 * Sends prompt via tmux.sendPrompt(), then waits for result by polling:
 * - Signal file (goal_complete) → status: completed
 * - Token threshold reached → status: context_high
 * - Hard timeout → status: timed_out
 * - interrupt() called → status: aborted
 *
 * interrupt() sends Ctrl-C to tmux; kill() force-terminates the session.
 */
export class LocalAgentExecution implements AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  private readonly worktreePath: string;
  private readonly sessionName: string;
  private readonly tmux: TmuxClient;
  private readonly generation: number;
  private readonly prompt: string;
  private readonly signalType: 'goal_complete';
  private done = false;
  private interruptAcked = false;

  constructor(opts: {
    worktreePath: string;
    sessionName: string;
    command: AgentCommand;
    generation: number;
    prompt: string;
    signalType: 'goal_complete';
    tmux: TmuxClient;
  }) {
    this.id = randomUUID();
    this.worktreePath = opts.worktreePath;
    this.sessionName = opts.sessionName;
    this.tmux = opts.tmux;
    this.generation = opts.generation;
    this.prompt = opts.prompt;
    this.signalType = opts.signalType;
    this.sessionId = opts.sessionName;
  }

  /** Send the goal to the tmux session — called by LocalSandbox.startAgent(). */
  async sendPrompt(): Promise<void> {
    // `sendGoal` is retained as a narrow compatibility seam for injected
    // legacy tmux fakes and older embedders; production TmuxClient exposes
    // sendPrompt as the canonical operation.
    if (typeof (this.tmux as any).sendPrompt === 'function') {
      await this.tmux.sendPrompt(this.worktreePath, this.sessionName, 'main', this.prompt, this.signalType);
    } else if (typeof (this.tmux as any).sendGoal === 'function') {
      await (this.tmux as any).sendGoal(this.worktreePath, this.sessionName, 'main', this.prompt, this.signalType);
    } else {
      throw new Error('tmux client does not support prompt dispatch');
    }
  }

  async waitForEvent(): Promise<ExecutionEvent | null> {
    // Local tmux does not have a streaming event API — this is a placeholder
    // for provider-specific streaming (Phase 3). Returns null until implemented.
    return null;
  }

  async waitForResult(options?: {
    completionTimeoutMs?: number;
    contextHighTokens?: number;
  }): Promise<ExecutionResult> {
    const completionTimeoutMs = options?.completionTimeoutMs ?? 600_000;
    const contextHighTokens = options?.contextHighTokens ?? Infinity;
    const start = Date.now();

    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Check for interrupt-acked flag set by interrupt()
      if (this.interruptAcked) {
        this.interruptAcked = false;
        return {
          version: 1,
          runId: this.id,
          status: 'aborted',
          provider: 'local',
          sessionId: this.sessionId,
          commits: [],
          branch: this.sessionName,
        };
      }

      // Check hard timeout
      if (Date.now() - start >= completionTimeoutMs) {
        this.done = true;
        return {
          version: 1,
          runId: this.id,
          status: 'timed_out',
          provider: 'local',
          sessionId: this.sessionId,
          commits: [],
          branch: this.sessionName,
        };
      }

      // Check for completion signal first (agent writes .afk-signal.json on goal_complete).
      // Completion must take priority over context_high: if goal is done, return immediately.
      try {
        const sig = await readSignal(this.worktreePath);
        if (sig?.type === 'goal_complete') {
          this.done = true;
          return {
            version: 1,
            runId: this.id,
            status: 'completed',
            provider: 'local',
            sessionId: this.sessionId,
            commits: [],
            branch: this.sessionName,
            structuredOutput: sig,
          };
        }
      } catch { /* ignore */ }

      // Check token threshold (context near limit → return context_high result).
      // Only checked after confirming goal is not yet complete.
      try {
        const rawUsage = await getTokenUsage(this.worktreePath);
        if (rawUsage.total >= contextHighTokens) {
          return {
            version: 1,
            runId: this.id,
            status: 'context_high',
            provider: 'local',
            sessionId: this.sessionId,
            usage: {
              inputTokens: rawUsage.input,
              outputTokens: rawUsage.output,
              totalTokens: rawUsage.total,
            },
            commits: [],
            branch: this.sessionName,
          };
        }
      } catch { /* ignore polling errors */ }

      await this.sleep(2000);
    }
  }

  async interrupt(_reason: InterruptReason): Promise<void> {
    if (this.done) return;
    try {
      await this.tmux.sendKeys(this.sessionName, 'main', 'C-c');
      this.interruptAcked = true;
    } catch {
      // Session gone → treat as dead
      this.interruptAcked = true;
      this.done = true;
    }
  }

  async kill(): Promise<void> {
    if (this.done) return;
    this.done = true;
    try {
      await this.tmux.killSession(this.sessionName);
    } catch { /* ignore */ }
  }

  async captureOutput(options?: CaptureOptions): Promise<string> {
    const { lines = 50, history = 100 } = options ?? {};
    return this.tmux.capturePane(this.sessionName, 'main', { lines, history });
  }

  async captureSession(): Promise<SessionSnapshot | undefined> {
    try {
      const output = await this.tmux.capturePane(this.sessionName, 'main', {
        lines: 200,
        history: 500,
      });
      const rawUsage = await getTokenUsage(this.worktreePath);
      return {
        sessionId: this.sessionId ?? this.id,
        generation: this.generation,
        checkpoint: null, // tmux does not support native session checkpoint
        summary: output,
        usage: {
          inputTokens: rawUsage.input,
          outputTokens: rawUsage.output,
          totalTokens: rawUsage.total,
        },
        capturedAt: new Date().toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  async resume(_options: ResumeOptions): Promise<AgentExecution> {
    // Resume logic (reading handoff doc, rebuilding prompt) is runner-owned.
    // This throws until Phase 3/4 implements native session restore.
    throw new Error(
      'LocalAgentExecution.resume not yet implemented — runner must inject handoff text',
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Options for LocalSandboxProvider.createWorktree()
 */
export interface LocalWorktreeOptions {
  iid: number;
  baseBranch: string;
  baseDir?: string;
}

/**
 * Local sandbox provider — creates LocalSandbox instances backed by
 * WorktreeManager + TmuxClient.
 *
 * Worktree lifecycle: runner calls createWorktree() before lifecycle hooks,
 * then create() to set up tmux after lifecycle hooks run.
 * This ordering allows modules (e.g., isolate) to run between worktree
 * creation and tmux session creation.
 */
export class LocalSandboxProvider implements SandboxProvider {
  readonly name: SandboxProviderName = 'local';
  readonly isolation: IsolationLevel = ISOLATION_LEVEL;
  readonly capabilities: ReadonlySet<SandboxCapability> = SANDBOX_CAPABILITIES;

  private readonly worktreeManager: WorktreeManager;

  constructor(worktreeManager: WorktreeManager = new WorktreeManager()) {
    this.worktreeManager = worktreeManager;
  }

  /**
   * Create a git worktree for the given issue.
   * Call this BEFORE lifecycle modules run; call create() AFTER.
   */
  async createWorktree(options: LocalWorktreeOptions): Promise<WorktreeInfo> {
    const wt = await this.worktreeManager.create(
      options.iid,
      options.baseBranch,
      options.baseDir,
    );
    return { iid: wt.iid, path: wt.path, branch: wt.branch };
  }

  /**
   * Provision a sandbox in an existing worktree. Agent launch is deferred to
   * LocalSandbox.startAgent so batch execution never touches tmux.
   * The worktree must already exist (created by createWorktree() or runner).
   *
   * Note: the TmuxClient passed in SandboxOptions must be the same instance
   * the HandoffCoordinator uses, so session lifecycle is coherent.
   */
  async create(options: SandboxOptions): Promise<Sandbox> {
    const { worktreePath, session, branch, tmux } = options;

    // Verify worktree exists
    try {
      await fs.access(worktreePath);
    } catch {
      throw new Error(
        `LocalSandboxProvider: worktree does not exist at ${worktreePath}`,
      );
    }

    return new LocalSandbox({
      id: randomUUID(),
      worktreePath,
      sessionName: session,
      branch,
      tmux,
    });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
