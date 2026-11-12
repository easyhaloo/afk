/**
 * Agent provider types — defines the interface for launching and interacting
 * with different Agent CLIs (Claude Code, Codex, Cursor, etc.).
 *
 * Each provider encapsulates:
 * - Command construction for the agent binary
 * - Stream parsing (capability: streaming)
 * - Session capture/restore (capability: resume)
 */

import type { AgentToolCallSummary } from '@afk/core';

/**
 * Provider identifiers are runtime extension points. The built-in provider
 * names remain the documented values, but a registry may supply any string.
 */
export type AgentProviderName = string;

/**
 * The limits a provider puts on the text AFK hands it.
 *
 * These are the provider's own constraints, not AFK's. A goal condition that
 * is too long is refused by the agent's TUI, and the refusal is silent: the
 * TUI prints one line, the agent never starts, and AFK waits out the whole
 * idle timeout before it can report a timeout instead of a cause. AFK has to
 * ask the provider what it accepts rather than guess a number here.
 */
export interface AgentPromptLimits {
  /**
   * The largest `/goal` condition the provider accepts, in characters.
   *
   * The limit belongs to the goal channel only: it applies to the condition
   * that follows the `/goal` command, not to a prompt that is delivered as an
   * ordinary message. A provider that accepts a 50,000-character message can
   * still refuse a 4,001-character goal condition.
   *
   * Absent when the provider declares no limit of its own.
   */
  goalConditionMaxChars?: number;
}

/** Capabilities that a provider may support. */
export type AgentCapability =
  | 'streaming'       // Provider emits structured event stream
  | 'structured-output' // Provider supports structured result format
  | 'usage'           // Provider can report token usage
  | 'resume'           // Provider supports native session resume
  | 'fork'             // Provider supports session forking
  | 'interactive';     // Provider supports HITL attach */

/** Token usage snapshot for a single generation. */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/** Command to execute — provider-built, runner-owned. */
export interface AgentCommand {
  /** Raw argv array (binary + args). */
  argv: string[];
  /** Env vars to inject (merged with process.env). */
  env?: Record<string, string>;
  /** Working directory for the agent process. */
  cwd?: string;
}

/** Execution mode — determines how the runner waits for agent completion. */
export type ExecutionMode = 'interactive' | 'batch';

/** Options for building an agent command. */
export interface AgentCommandOptions {
  /** Path the agent should operate in. */
  worktreePath: string;
  /** Session identifier (used for resume/restore). */
  sessionId: string;
  /** Initial prompt or goal text. */
  goal?: string;
  /** Whether to attach interactively (HITL). */
  interactive?: boolean;
  /** Execution mode: 'interactive' (tmux + signal file) or 'batch' (stream-json). */
  executionMode?: ExecutionMode;
  /** Immutable provider runtime resolved before backlog claim. */
  runtime?: AgentRuntimeSelection;
}

export interface AgentExecutionMetadata {
  provider: AgentProviderName;
  transport: 'process' | 'exec' | 'app-server';
  auth?: 'chatgpt' | 'api' | 'unknown';
  modelProvider?: string;
  endpointKind?: 'stdio' | 'unix' | 'ws' | 'wss';
  threadId?: string;
}

export interface CodexRuntimeSelection {
  kind: 'codex';
  transport: 'exec' | 'app-server';
  auth: 'chatgpt' | 'api' | 'unknown';
  provider: string;
  profile?: string;
  endpoint?: string;
  authTokenEnv?: string;
  startupTimeoutMs: number;
}

export type AgentRuntimeSelection = { kind: 'default' } | CodexRuntimeSelection;

/** Minimal execution host implemented by local and container sandboxes. */
export interface AgentExecutionHost {
  readonly worktreePath: string;
  readonly workspacePath: string;
  startAgent(options: AgentStartOptions): Promise<AgentExecution>;
}

export interface AgentExecutionOptions extends AgentCommandOptions {
  sandbox: AgentExecutionHost;
  prompt: string;
  signalType: 'goal_complete';
  generation: number;
  runtime?: AgentRuntimeSelection;
}

/** An event emitted by the agent during execution. */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'session'; sessionId: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'result'; result: unknown }
  | { type: 'error'; error: Error };

/** Provider-neutral options used by an execution host to start an agent. */
export interface AgentStartOptions {
  command: AgentCommand;
  metadata: AgentExecutionMetadata;
  generation: number;
  prompt: string;
  signalType: 'goal_complete';
  executionMode?: ExecutionMode;
  parseLine?: (line: string) => AgentEvent[];
}

/** Snapshot of an agent session state — used for resume/restore. */
export interface SessionSnapshot {
  sessionId: string;
  generation: number;
  /** Provider-native checkpoint data (e.g., Claude Code session dir). */
  checkpoint: unknown;
  /** Human-readable summary for Markdown handoff fallback. */
  summary: string;
  usage?: TokenUsage;
  /** ISO timestamp of snapshot capture. */
  capturedAt: string;
}

/** Options for capturing a session snapshot. */
export interface CaptureSessionOptions {
  sessionId: string;
  worktreePath: string;
}

/** Options for restoring a session from a snapshot. */
export interface RestoreSessionOptions {
  snapshot: SessionSnapshot;
  worktreePath: string;
}

export type InterruptReason = 'context-high' | 'timeout' | 'manual' | 'error';

export interface CaptureOptions {
  lines?: number;
  history?: number;
}

export interface ResumeOptions {
  snapshot: SessionSnapshot;
}

export type ExecutionEvent =
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'error'; error: Error }
  | { type: 'interrupt-acked' }
  | { type: 'killed' };

/**
 * Facts about how an execution ended that the failure message cannot carry.
 *
 * A timeout is not "the agent failed": it is "the agent had this much time
 * and this was the last time it did something". Those are the numbers an
 * operator needs, and they only exist at the moment the provider gives up.
 */
export interface ExecutionDiagnostics {
  /** Set when the execution ended because a time budget ran out. */
  timeout?: {
    /** Which budget ran out. */
    kind: 'idle' | 'completion' | 'hard';
    /** The budget that ran out, in milliseconds. */
    budgetMs: number;
    /** How long the agent had been silent, when that is what was measured. */
    idleMs?: number;
    /** When the agent last produced output, when that is known. */
    lastActivityAt?: string;
  };
}

/**
 * What an agent run says about its turn.
 *
 * A turn is the agent's own unit of work: the model answers, runs tools, and
 * answers again until it hands the turn back. Some agents say in their own
 * records when a turn ended or died; AFK reads that record instead of
 * waiting out the idle timeout on a turn that is already over.
 */
export interface AgentTurnVerdict {
  /** Why the turn is over. */
  message: string;
  /** The provider's own error code, when it gave one. */
  code?: string;
  /**
   * True when the turn ended normally: the agent is back at its prompt and
   * will produce nothing more.
   */
  ended?: boolean;
}

/**
 * Watches one agent session for a turn that ended or died.
 *
 * The watcher reads the agent's own record of the turn — Codex writes a
 * rollout, Claude Code writes a transcript — because nothing about the
 * process says so: the TUI stays open, waiting for the next prompt.
 */
export interface AgentTurnWatcher {
  /**
   * Look at the agent's record of the turn.
   *
   * Returns undefined while the turn is still running. `sinceMs` is when
   * this attempt started: a record from an earlier attempt in the same
   * worktree is not this attempt's business.
   */
  check(workingDirectory: string, sinceMs?: number): Promise<AgentTurnVerdict | undefined>;
}

export interface ExecutionResult {
  version: 1;
  runId: string;
  status: 'completed' | 'blocked' | 'failed' | 'aborted' | 'timed_out' | 'context_high';
  provider: string;
  sessionId?: string;
  exitCode?: number;
  structuredOutput?: unknown;
  usage?: TokenUsage;
  tools?: AgentToolCallSummary[];
  commits: string[];
  branch?: string;
  error?: { code: string; message: string };
  /** Facts about how the execution ended that the error message cannot carry. */
  diagnostics?: ExecutionDiagnostics;
}

export interface AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  readonly metadata: AgentExecutionMetadata;
  waitForEvent(): Promise<ExecutionEvent | null>;
  waitForResult(options?: {
    completionTimeoutMs?: number;
    contextHighTokens?: number;
    /**
     * How long the agent may stay silent before the wait gives up on it.
     *
     * The completion timeout bounds how long the agent may take; this
     * bounds how long it may say nothing. An agent that dies is silent, so
     * this is what turns a dead agent into a failed run instead of a wait
     * that runs until the hard timeout.
     */
    idleTimeoutMs?: number;
  }): Promise<ExecutionResult>;
  interrupt(reason: InterruptReason): Promise<void>;
  kill(): Promise<void>;
  captureOutput(options?: CaptureOptions): Promise<string>;
  captureSession(): Promise<SessionSnapshot | undefined>;
  resume(options: ResumeOptions): Promise<AgentExecution>;
}

/**
 * Agent provider interface.
 *
 * Each concrete provider (claude-code.ts, codex.ts, etc.) implements this
 * interface and registers via the agent registry.
 */
export interface AgentProvider {
  readonly name: AgentProviderName;
  readonly capabilities: ReadonlySet<AgentCapability>;

  /**
   * The limits this provider puts on the text AFK hands it.
   *
   * Optional: a provider that declares none is treated as the strictest
   * limit AFK knows of, so an over-long goal is caught before dispatch
   * instead of after a silent refusal. `resolveGoalConditionLimit` in
   * `prompt-budget.ts` holds that default and its reasoning.
   */
  readonly promptLimits?: AgentPromptLimits;

  createExecution(options: AgentExecutionOptions): Promise<AgentExecution>;

  /**
   * Get token usage for a running or completed session.
   * Only required if the provider has 'usage' capability.
   */
  getSessionUsage?(session: AgentSession): Promise<TokenUsage | undefined>;

  /**
   * Capture the current session state for later resume.
   * Only required if the provider has 'resume' capability.
   */
  captureSession?(options: CaptureSessionOptions): Promise<SessionSnapshot>;

  /**
   * Restore a session from a snapshot.
   * Only required if the provider has 'resume' capability.
   */
  restoreSession?(options: RestoreSessionOptions): Promise<void>;
}

/** Minimal session descriptor — used by getSessionUsage and captureSession. */
export interface AgentSession {
  sessionId: string;
  worktreePath: string;
}
