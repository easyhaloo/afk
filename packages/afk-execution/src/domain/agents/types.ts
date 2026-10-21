/**
 * Agent provider types — defines the interface for launching and interacting
 * with different Agent CLIs (Claude Code, Codex, Cursor, etc.).
 *
 * Each provider encapsulates:
 * - Command construction for the agent binary
 * - Stream parsing (capability: streaming)
 * - Session capture/restore (capability: resume)
 */

import type { AgentExecutionMode, AgentProviderName, AgentToolCallSummary } from '@afk/core';

/**
 * The agent providers AFK can drive.
 *
 * The list and the type live in the core package, where the desktop
 * client can read them from a renderer that cannot load this package.
 * The execution runtime names them from there rather than writing a
 * second answer down.
 */
export type { AgentProviderName };

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

/**
 * How the runner waits for agent completion.
 *
 * The list and the type live in the core package, where the audit spine
 * records the mode and every entry point can reach them. The execution
 * runtime names them from there rather than writing a second answer down.
 */
export type { AgentExecutionMode };

/**
 * The mode a run uses when nobody names one.
 *
 * The interactive mode is the default: the agent runs in a tmux session, so
 * a person can attach to it and the run can hand the work over to a fresh
 * session. The batch mode is the headless one, and a caller asks for it
 * when it wants no session — the verification phase, for one.
 */
export const DEFAULT_AGENT_EXECUTION_MODE: AgentExecutionMode = 'interactive';

/** Options for building an agent command. */
export interface AgentCommandOptions {
  /** Path the agent should operate in. */
  worktreePath: string;
  /** Session identifier (used for resume/restore). */
  sessionId: string;
  /** Initial prompt or goal text. */
  goal?: string;
  /**
   * Execution mode: 'interactive' (tmux + signal file) or 'batch' (stream-json).
   *
   * The mode is the only switch. An earlier contract carried a second flag
   * beside it, and nothing on the live path ever set it — so the providers
   * that read it took the branch that belonged to the other mode, and an
   * interactive cursor run was told to print once and exit.
   */
  executionMode?: AgentExecutionMode;
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
  executionMode?: AgentExecutionMode;
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

export interface ExecutionResult {
  version: 1;
  runId: string;
  status: 'completed' | 'failed' | 'aborted' | 'timed_out' | 'context_high';
  /**
   * The agent that ran.
   *
   * The agent name, not the sandbox it ran in: this is the field the failure
   * summary names, and a summary that says `local` says nothing about which
   * agent gave up. It is the same name the execution's metadata carries.
   */
  provider: AgentProviderName;
  sessionId?: string;
  exitCode?: number;
  structuredOutput?: unknown;
  usage?: TokenUsage;
  tools?: AgentToolCallSummary[];
  commits: string[];
  branch?: string;
  error?: { code: string; message: string };
}

export interface AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  readonly metadata: AgentExecutionMetadata;
  /**
   * Where the agent's own transcript lives, when the provider writes one.
   *
   * The provider knows it and the telemetry reader needs it, so it belongs to
   * the contract rather than to a cast at the reading site.
   */
  readonly telemetryPath?: string;
  /**
   * Wait for the execution to end.
   *
   * `completionTimeoutMs` — how long to wait before giving up on the
   * agent.
   *
   * `contextHighTokens` — the context size at which the run should hand
   * the work over. The execution reports `context_high` once it reaches
   * it, and the runner takes it from there: a native resume where the
   * provider has one, a handoff with the session otherwise.
   *
   * A context size and what an agent spent are two different numbers,
   * and only an execution that can see the first can answer this. The
   * interactive execution reads it off the statusline. The others cannot:
   * a container has neither a statusline nor a usage of its own, the
   * codex app-server transport reports the turn that ended rather than
   * the context as it grows, and the batch execution's stream carries
   * what the agent spent. Each of them says so where it is implemented.
   */
  waitForResult(options?: { completionTimeoutMs?: number; contextHighTokens?: number }): Promise<ExecutionResult>;
  interrupt(reason: InterruptReason): Promise<void>;
  kill(): Promise<void>;
  captureOutput(options?: CaptureOptions): Promise<string>;
  captureSession(): Promise<SessionSnapshot | undefined>;
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

  createExecution(options: AgentExecutionOptions): Promise<AgentExecution>;

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
