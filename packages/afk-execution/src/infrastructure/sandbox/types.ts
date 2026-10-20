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
} from '../../domain/agents/types.js';
export type {
  AgentExecution,
  AgentStartOptions,
  CaptureOptions,
  ExecutionEvent,
  ExecutionResult,
  InterruptReason,
  ResumeOptions,
} from '../../domain/agents/types.js';

export type SandboxProviderName = 'local' | 'docker' | 'podman';

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
  tmux?: import('../tmux/tmux.js').TmuxClient;
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

/**
 * Sandbox provider interface — factory for Sandboxes.
 *
 * A provider is given a worktree that already exists: the branch provider
 * creates it, and the sandbox runs the agent inside it. A provider that
 * created worktrees as well would have two owners for one directory.
 */
export interface SandboxProvider {
  readonly name: SandboxProviderName;

  /**
   * Create a new sandbox for the given options.
   * The sandbox is not started until startAgent() is called.
   */
  create(options: SandboxOptions): Promise<Sandbox>;
}
