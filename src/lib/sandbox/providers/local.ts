/**
 * Local sandbox provider — wraps git worktree + tmux as a unified Sandbox.
 *
 * Implements the SandboxProvider interface using existing WorktreeManager and
 * TmuxClient components without changing their behavior.
 *
 * Responsibilities:
 * - SandboxProvider.createWorktree() → creates git worktree via WorktreeManager
 * - SandboxProvider.create() → creates tmux session in existing worktree
 * - Sandbox.startAgent() → launches agent via tmux.sendGoal
 * - AgentExecution → wraps tmux session lifecycle with ExecutionResult
 *
 * Does NOT manage lifecycle modules (isolate, etc.) — those are runner-owned.
 */

import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { WorktreeManager } from '../../core/git/worktree';
import { TmuxClient } from '../../core/tmux/tmux';
import { getTokenUsage } from '../../io';
import { readLegacySignalResult } from '../legacy-compat';
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
import type { SessionSnapshot } from '../../agents/types';

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
    const execution = new LocalAgentExecution({
      worktreePath: this.worktreePath,
      sessionName: this.sessionName,
      command: options.command,
      generation: options.generation,
      goalText: options.goalText,
      signalType: options.signalType,
      tmux: this.tmux,
    });
    await execution.sendGoal();
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
 * Sends goal via tmux.sendGoal(), then waits for result by polling:
 * - Signal file (goal_complete / ac_result) → status: completed
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
  private readonly goalText: string;
  private readonly signalType: 'goal_complete' | 'ac_result';
  private done = false;
  private interruptAcked = false;

  constructor(opts: {
    worktreePath: string;
    sessionName: string;
    command: import('../../agents/types').AgentCommand;
    generation: number;
    goalText: string;
    signalType: 'goal_complete' | 'ac_result';
    tmux: TmuxClient;
  }) {
    this.id = randomUUID();
    this.worktreePath = opts.worktreePath;
    this.sessionName = opts.sessionName;
    this.tmux = opts.tmux;
    this.generation = opts.generation;
    this.goalText = opts.goalText;
    this.signalType = opts.signalType;
    this.sessionId = opts.sessionName;
  }

  /** Send the goal to the tmux session — called by LocalSandbox.startAgent(). */
  async sendGoal(): Promise<void> {
    await this.tmux.sendGoal(
      this.worktreePath,
      this.sessionName,
      'main',
      this.goalText,
      this.signalType,
    );
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

      // Check token threshold (context near limit → return context_high result)
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

      // Check legacy signal file (Phase 8 fallback for pre-Phase-8 worktrees).
      // New agents do not write this file — they complete via ExecutionResult.
      // The adapter lives in sandbox/legacy-compat.ts.
      const legacyResult = await readLegacySignalResult(this.worktreePath, this.id);
      if (legacyResult) {
        this.done = true;
        return {
          ...legacyResult,
          sessionId: this.sessionId,
          branch: this.sessionName,
        };
      }

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
   * Create a tmux session in an existing worktree.
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

    if (!tmux) {
      throw new Error(
        'LocalSandboxProvider.create() requires tmux in SandboxOptions',
      );
    }

    // Create tmux session + wait for prompt inside the sandbox provider so the
    // runner doesn't have to know about tmux lifecycle details. The same TmuxClient
    // instance must be passed in (kept here for tests / sandbox abstraction).
    await tmux.createSession(session, worktreePath);
    await tmux.waitForPrompt(worktreePath, 30_000);

    return new LocalSandbox({
      id: randomUUID(),
      worktreePath,
      sessionName: session,
      branch,
      tmux,
    });
  }
}
