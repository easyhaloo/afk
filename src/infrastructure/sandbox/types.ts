/**
 * Sandbox provider types — unified abstraction for local (worktree+tmux) and
 * container (docker/podman) execution environments.
 *
 * The SandboxProvider creates Sandboxes; each Sandbox runs AgentExecutions.
 * This separates "where agent runs" (Sandbox) from "which agent runs"
 * (AgentProvider) and "what workflow steps run" (WorkflowTemplate).
 */

import type { AgentCommand, AgentEvent, SessionSnapshot, TokenUsage, ExecutionMode, AgentProvider } from '../agents/types';

export type SandboxProviderName = 'local' | 'docker' | 'podman';

export type IsolationLevel = 'workspace' | 'process' | 'filesystem' | 'vm';

export type SandboxCapability =
  | 'streaming-exec'       // Provider supports streaming output from exec
  | 'interrupt-process'    // Provider can interrupt (not kill) the agent process
  | 'kill-process'         // Provider can forcibly terminate the agent process
  | 'persistent-filesystem' // Provider preserves filesystem across agent restarts
  | 'copy-files'           // Provider supports file copy into sandbox
  | 'session-transfer';    // Provider supports session capture/restore

/** Options passed to SandboxProvider.create() */
export interface SandboxOptions {
  /** Path to the worktree / workspace directory. */
  worktreePath: string;
  /** Session name — used for tmux session naming in local mode. */
  session: string;
  /** Branch name (for display/logging). */
  branch?: string;
  /** Whether to attach interactively (HITL). */
  interactive?: boolean;
  /** Env vars to inject into the sandbox. */
  env?: Record<string, string>;
  /**
   * TmuxClient instance to use. For local provider this must be the same
   * instance the HandoffCoordinator uses, so session lifecycle is coherent.
   */
  tmux?: import('../core/tmux/tmux').TmuxClient;
  /** Execution mode: 'interactive' (tmux + signal file) or 'batch' (stream-json). */
  executionMode?: ExecutionMode;
}

/** A started sandbox — can create AgentExecutions. */
export interface Sandbox {
  readonly id: string;
  readonly worktreePath: string;
  readonly workspacePath: string;

  /**
   * Start an agent execution inside this sandbox.
   * The sandbox owns the process lifecycle; the runner manages the workflow.
   */
  startAgent(options: AgentStartOptions): Promise<AgentExecution>;

  /**
   * Permanently close this sandbox and release all resources.
   * Idempotent — safe to call multiple times.
   */
  close(): Promise<void>;
}

/** Options for Sandbox.startAgent() */
export interface AgentStartOptions {
  /** Pre-built agent command from AgentProvider. */
  command: AgentCommand;
  /** Generation index for this execution (1 = first generation). */
  generation: number;
  /** Goal/prompt text to send to the agent. */
  prompt: string;
  /** Completion signal shared by all automated agent steps. */
  signalType: 'goal_complete';
  /** Execution mode: 'interactive' (tmux + signal file) or 'batch' (stream-json). */
  executionMode?: ExecutionMode;
  /**
   * Agent provider instance for batch mode event parsing.
   * Required when executionMode is 'batch'.
   */
  agentProvider?: AgentProvider;
}

/** Reason for an interrupt — determines graceful vs. forced termination. */
export type InterruptReason =
  | 'context-high'   // Token threshold reached, handing off
  | 'timeout'         // Hard timeout reached
  | 'manual'          // User or runner manually interrupted
  | 'error';         // Agent or sandbox error requiring restart */

/**
 * A running or completed agent execution inside a Sandbox.
 *
 * interrupt() and kill() are distinct:
 *   interrupt = graceful stop, session preserved for resume/handoff
 *   kill     = forced termination, session may be lost
 */
export interface AgentExecution {
  readonly id: string;
  readonly sessionId?: string;

  /**
   * Wait for the next event from this execution.
   * Returns null when the execution has ended.
   */
  waitForEvent(): Promise<ExecutionEvent | null>;

  /**
   * Wait for the final result of this execution.
   * Resolves when the agent completes, errors, or is interrupted.
   */
  waitForResult(options?: { completionTimeoutMs?: number; contextHighTokens?: number }): Promise<ExecutionResult>;

  /**
   * Gracefully interrupt the agent — send Ctrl-C equivalent.
   * Preserves session state for resume or handoff.
   * After interrupt(), waitForResult() will resolve.
   */
  interrupt(reason: InterruptReason): Promise<void>;

  /**
   * Forcibly terminate the agent process.
   * Session state is NOT preserved.
   * After kill(), waitForResult() will resolve.
   */
  kill(): Promise<void>;

  /**
   * Capture current pane output as a string.
   */
  captureOutput(options?: CaptureOptions): Promise<string>;

  /**
   * Capture the session snapshot for resume or handoff.
   * Returns undefined if the provider doesn't support session capture.
   */
  captureSession(): Promise<SessionSnapshot | undefined>;

  /**
   * Resume this execution from a captured session snapshot.
   * Starts a new AgentExecution with the restored session.
   */
  resume(options: ResumeOptions): Promise<AgentExecution>;
}

/** Event emitted by an AgentExecution. */
export type ExecutionEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'error'; error: Error }
  | { type: 'interrupt-acked' }
  | { type: 'killed' };

/** Final result of an AgentExecution. */
export interface ExecutionResult {
  version: 1;
  runId: string;
  status: 'completed' | 'blocked' | 'failed' | 'aborted' | 'timed_out' | 'context_high';
  provider: string;
  sessionId?: string;
  exitCode?: number;
  /** Provider-native structured output (e.g., signal type, parsed result). */
  structuredOutput?: unknown;
  usage?: TokenUsage;
  /** Commit SHAs created during this execution. */
  commits: string[];
  branch?: string;
  error?: {
    code: string;
    message: string;
  };
}

/** Options for AgentExecution.captureOutput() */
export interface CaptureOptions {
  lines?: number;
  history?: number;
}

/** Options for AgentExecution.resume() */
export interface ResumeOptions {
  snapshot: SessionSnapshot;
}

/** Minimal worktree info returned by createWorktree — avoids circular dep with core/git/worktree. */
export interface WorktreeInfo {
  iid: number;
  path: string;
  branch: string;
}

/** Sandbox provider interface — factory for Sandboxes. */
export interface SandboxProvider {
  readonly name: SandboxProviderName;
  readonly isolation: IsolationLevel;
  readonly capabilities: ReadonlySet<SandboxCapability>;

  /**
   * Create a git worktree for the given issue.
   * Called BEFORE lifecycle modules run; create() is called AFTER.
   * Container providers that don't use host worktrees may be no-op.
   */
  createWorktree(options: { iid: number; baseBranch: string }): Promise<WorktreeInfo>;

  /**
   * Create a new sandbox for the given options.
   * The sandbox is not started until startAgent() is called.
   */
  create(options: SandboxOptions): Promise<Sandbox>;
}
