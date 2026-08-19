/**
 * Agent provider types — defines the interface for launching and interacting
 * with different Agent CLIs (Claude Code, Codex, Cursor, etc.).
 *
 * Each provider encapsulates:
 * - Command construction for the agent binary
 * - Stream parsing (capability: streaming)
 * - Session capture/restore (capability: resume)
 */

export type AgentProviderName =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'pi'
  | 'opencode'
  | 'copilot';

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
  | { type: 'tool-start'; name: string }
  | { type: 'tool-end'; name: string }
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

export interface ExecutionResult {
  version: 1;
  runId: string;
  status: 'completed' | 'blocked' | 'failed' | 'aborted' | 'timed_out' | 'context_high';
  provider: string;
  sessionId?: string;
  exitCode?: number;
  structuredOutput?: unknown;
  usage?: TokenUsage;
  commits: string[];
  branch?: string;
  error?: { code: string; message: string };
}

export interface AgentExecution {
  readonly id: string;
  readonly sessionId?: string;
  readonly metadata: AgentExecutionMetadata;
  waitForEvent(): Promise<ExecutionEvent | null>;
  waitForResult(options?: { completionTimeoutMs?: number; contextHighTokens?: number }): Promise<ExecutionResult>;
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
