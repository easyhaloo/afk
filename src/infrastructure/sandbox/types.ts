/**
 * Sandbox provider types — unified abstraction for local (worktree+tmux) and
 * container (docker/podman) execution environments.
 *
 * The SandboxProvider creates Sandboxes; each Sandbox runs AgentExecutions.
 * This separates "where agent runs" (Sandbox) from "which agent runs"
 * (AgentProvider) and "what workflow steps run" (WorkflowTemplate).
 */

import type {
  AgentExecution,
  AgentExecutionHost,
  AgentStartOptions,
  ExecutionMode,
} from '../../domain/agents/types';
export type {
  AgentExecution,
  AgentStartOptions,
  CaptureOptions,
  ExecutionEvent,
  ExecutionResult,
  InterruptReason,
  ResumeOptions,
} from '../../domain/agents/types';

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
  tmux?: import('../tmux/tmux').TmuxClient;
  /** Execution mode: 'interactive' (tmux + signal file) or 'batch' (stream-json). */
  executionMode?: ExecutionMode;
  /** Project workspace that owns this worktree; used for AFK resource registry scoping. */
  workspaceRoot?: string;
  /** Durable TaskRuntimeRecord runId when one has already been created. */
  runtimeRunId?: string;
}

/** A started sandbox — can create AgentExecutions. */
export interface Sandbox extends AgentExecutionHost {
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
