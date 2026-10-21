import type { AgentExecutionMode } from './agent-execution-mode.js';
import type { AgentAuth, AgentTransport } from './agent-runtime-environment.js';

/**
 * The records of the runs the runtime is tracking.
 *
 * The runtime writes them; the board lists them, the desktop reads the
 * ones behind a work item, and the command that stops a run finds the run
 * it is stopping. They are the runtime's own vocabulary, and every layer
 * that reads a run has to read the same one - a board that shows a phase
 * the desktop does not know about is a board and a desktop that disagree
 * about the same run.
 *
 * The shapes live in the core package because the desktop's renderer reads
 * them, and the core package is the one layer the renderer can load.
 */

/**
 * The phases a run goes through.
 *
 * The rule lives here because the desktop's renderer reads it too, and the
 * record module names it from here.
 */
export const TASK_RUNTIME_PHASES = ['implementing', 'verifying'] as const;

export type TaskRuntimePhase = (typeof TASK_RUNTIME_PHASES)[number];

export type TaskRuntimeStatus = 'running' | 'completed' | 'blocked' | 'failed';

export type VisibleTaskRuntimeStatus = TaskRuntimeStatus | 'stale';

export type TaskRuntimeActivityKind = 'agent' | 'tool' | 'test' | 'state' | 'qa' | 'error';

export interface TaskRuntimeActivity {
  id: string;
  taskRunId: string;
  at: string;
  kind: TaskRuntimeActivityKind;
  message: string;
  detail?: string;
}

/**
 * The read model — a runtime record as history knows it.
 *
 * `sandboxProvider`, `executionMode` and `agentProvider` are optional here,
 * because history does not always know them: a record written before those
 * fields existed is still history, and a reader that demanded them would
 * drop it. Nothing is invented in their place — a record that does not
 * carry them says so.
 */
export interface TaskRuntimeRecord {
  runId: string;
  backlogId: string;
  workspace?: string;
  providerRef?: string;
  title?: string;
  phase: TaskRuntimePhase;
  status: TaskRuntimeStatus;
  sandboxProvider?: string;
  executionMode?: AgentExecutionMode;
  agentProvider?: string;
  agentTransport?: AgentTransport;
  agentAuth?: AgentAuth;
  agentModelProvider?: string;
  agentThreadId?: string;
  session?: string;
  worktree?: string;
  branch?: string;
  startedAt: string;
  heartbeatAt: string;
  progress?: string;
  diagnosticPath?: string;
  errorSummary?: string;
  completedAt?: string;
  activities?: TaskRuntimeActivity[];
}

/**
 * The write model — what a run publishes about its environment.
 *
 * A run knows the sandbox it ran in, the mode it ran in and the agent it
 * ran, so all three are required here. The read model is looser only
 * because the past is looser; every runner publishes through
 * `runtimeRecord()`, which always fills them in.
 */
export interface TaskRuntimeRecordInput extends Omit<TaskRuntimeRecord, 'sandboxProvider' | 'executionMode' | 'agentProvider'> {
  sandboxProvider: string;
  executionMode: AgentExecutionMode;
  agentProvider: string;
}

export type ActiveTaskRuntimeRecord = Omit<TaskRuntimeRecord, 'status'> & {
  status: 'running' | 'stale';
};

/** Which bucket a record was read from. */
export type RuntimeRecordBucket = 'active' | 'archive';

/**
 * Which runtime records belong to a work item.
 *
 * Two readers used to answer this differently: one matched on `providerRef`
 * and ignored the workspace, the other matched on `backlogId` and required
 * the workspace. The same record could therefore be shown by one view and
 * hidden by the other, and the two views could answer "is this run still
 * going?" differently for the same run.
 *
 * The rule is per field, and strict: a caller that knows the provider-
 * qualified work item id requires the record's `providerRef` to match it,
 * and a caller that knows the provider's own backlog id requires
 */
export interface RuntimeRecordIdentity {
  /** The provider-qualified work item id, e.g. `github:org/repo#42`. */
  workItemId?: string;
  /** The provider's own backlog id, e.g. `42`. */
  backlogId?: string;
  /** The workspace root the record must belong to. */
  workspace?: string;
}

/** Which records a reader is asked for. */
export interface RuntimeRecordQuery {
  /** The work item the records must belong to. */
  identity?: RuntimeRecordIdentity;
  /** Only records that started at or after this instant. */
  startedAfter?: string;
}

/** A record as a reader hands it over. */
export interface RuntimeRecordEntry {
  record: TaskRuntimeRecord;
  bucket: RuntimeRecordBucket;
  status: VisibleTaskRuntimeStatus;
}
