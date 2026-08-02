/**
 * Local sandbox provider — wraps git worktree + tmux as a unified Sandbox.
 *
 * Implements the SandboxProvider interface using existing WorktreeManager and
 * TmuxClient components without changing their behavior.
 *
 * Responsibilities:
 * - create() → creates/reuses worktree + tmux session
 * - Sandbox.startAgent() → launches agent via tmux.sendGoal
 * - interrupt() → tmux Ctrl-C + session capture
 * - close() → tmux cleanup + worktree state update
 *
 * Does NOT manage lifecycle modules (isolate, etc.) — those are runner-owned.
 */

import { join } from 'path';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { WorktreeManager } from '../core/git/worktree';
import { TmuxClient } from '../core/tmux/tmux';
import { SIGNAL_FILE, getTokenUsage } from '../io';
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
} from './types';
import type { SessionSnapshot } from '../agents/types';
import { readSignal } from '../io';

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

  constructor(opts: {
    id: string;
    worktreePath: string;
    sessionName: string;
    branch?: string;
    tmux: TmuxClient;
  }) {
    this.id = opts.id;
    this.worktreePath = opts.worktreePath;
    this.workspacePath = opts.worktreePath; // local: workspace == worktree
    this.tmux = opts.tmux;
    this.sessionName = opts.sessionName;
    this.branch = opts.branch;
  }

  async startAgent(options: AgentStartOptions): Promise<AgentExecution> {
    if (this._closed) throw new Error('sandbox already closed');
    return new LocalAgentExecution({
      worktreePath: this.worktreePath,
      sessionName: this.sessionName,
      command: options.command,
      generation: options.generation,
      tmux: this.tmux,
      branch: this.branch,
    });
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
 * Uses the existing signal-file polling pattern from WorkflowRunner:
 * - startAgent: sends goal via tmux.sendGoal (non-blocking spawn)
 * - waitForResult: polls for signal file OR token threshold
 * - interrupt: tmux Ctrl-C + session capture
 * - kill: tmux kill-session
 */
export class LocalAgentExecution implements AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  private readonly worktreePath: string;
  private readonly sessionName: string;
  private readonly tmux: TmuxClient;
  private readonly generation: number;
  private done = false;
  private interruptAcked = false;

  constructor(opts: {
    worktreePath: string;
    sessionName: string;
    command: import('../agents/types').AgentCommand;
    generation: number;
    tmux: TmuxClient;
    branch?: string;
  }) {
    this.id = randomUUID();
    this.worktreePath = opts.worktreePath;
    this.sessionName = opts.sessionName;
    this.tmux = opts.tmux;
    this.generation = opts.generation;
    this.sessionId = opts.sessionName;
  }

  async waitForEvent(): Promise<ExecutionEvent | null> {
    // Local tmux doesn't have a streaming event API — this is a placeholder
    // for provider-specific streaming. For now, return null (sync with
    // signal-file polling in waitForResult).
    return null;
  }

  async waitForResult(): Promise<ExecutionResult> {
    const signalPath = join(this.worktreePath, SIGNAL_FILE);

    // Poll for signal file — same pattern as WorkflowRunner.waitForPhaseSignal
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const signal = await readSignal(this.worktreePath);
        if (signal) {
          this.done = true;
          return {
            version: 1,
            runId: this.id,
            status: signal.type === 'goal_complete' || signal.type === 'ac_result' ? 'completed' : 'failed',
            provider: 'local',
            sessionId: this.sessionId,
            structuredOutput: signal,
            commits: [],
            branch: this.sessionName,
          };
        }
      } catch { /* ignore polling errors */ }

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

      await this.sleep(2000);
    }
  }

  async interrupt(reason: InterruptReason): Promise<void> {
    if (this.done) return;
    // Send Ctrl-C to the tmux session
    try {
      await this.tmux.sendKeys(this.sessionName, 'main', 'C-c');
      this.interruptAcked = true;
    } catch (err) {
      // If sendKeys fails (session gone), treat as already dead
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
      const output = await this.capturePane({ lines: 200, history: 500 });
      const rawUsage = await getTokenUsage(this.worktreePath);
      return {
        sessionId: this.sessionId ?? this.id,
        generation: this.generation,
        checkpoint: null, // tmux doesn't support native checkpoint
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
    // Resume in local sandbox: start a new tmux session (sessionName-suffix)
    // The actual resume logic (reading handoff doc, rebuilding prompt) is
    // runner-owned — we just start the new execution here.
    throw new Error('LocalAgentExecution.resume not yet implemented — runner must handle handoff text injection');
  }

  private async capturePane(options: CaptureOptions): Promise<string> {
    const { lines = 50, history = 100 } = options;
    return this.tmux.capturePane(this.sessionName, 'main', { lines, history });
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
  private readonly tmuxFactory: () => TmuxClient;

  /**
   * @param worktreeManager - WorktreeManager instance (may be shared with runner)
   * @param tmuxFactory - Factory for TmuxClient instances (default: () => new TmuxClient())
   */
  constructor(
    worktreeManager: WorktreeManager = new WorktreeManager(),
    tmuxFactory: () => TmuxClient = () => new TmuxClient(),
  ) {
    this.worktreeManager = worktreeManager;
    this.tmuxFactory = tmuxFactory;
  }

  /**
   * Create a git worktree for the given issue.
   * Call this BEFORE lifecycle modules run; call create() AFTER.
   */
  async createWorktree(options: LocalWorktreeOptions): Promise<WorktreeInfo> {
    const wt = await this.worktreeManager.create(options.iid, options.baseBranch, options.baseDir);
    return { iid: wt.iid, path: wt.path, branch: wt.branch };
  }

  /**
   * Create a tmux session in an existing worktree.
   * The worktree must already exist (created by createWorktree() or runner).
   */
  async create(options: SandboxOptions): Promise<Sandbox> {
    const { worktreePath, session, branch } = options;

    // Verify worktree exists
    try {
      await fs.access(worktreePath);
    } catch {
      throw new Error(`LocalSandboxProvider: worktree does not exist at ${worktreePath}`);
    }

    const tmux = this.tmuxFactory();
    const sandboxId = randomUUID();

    await tmux.createSession(session, worktreePath);
    await tmux.waitForPrompt(worktreePath, 30000);

    return new LocalSandbox({
      id: sandboxId,
      worktreePath,
      sessionName: session,
      branch,
      tmux,
    });
  }
}
