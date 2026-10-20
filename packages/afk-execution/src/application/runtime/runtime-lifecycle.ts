/**
 * The runtime lifecycle — one module that owns a run's runtime record.
 *
 * The workflow runner and the QA runner each wrote the same four steps:
 * publish the record, heartbeat it, archive it, and write what the run
 * produced. The copies drifted: one published `implementing` and the other
 * `verifying`, one logged `failed to publish workflow runtime` and the other
 * `failed to publish QA runtime`, and only one of them carried a default
 * error summary. The record shape was already shared; the lifecycle around
 * it was not, so a rule added to one runner and not the other was a rule
 * half the monitor knew.
 *
 * This module owns the lifecycle. What a runner says about itself — the
 * phase it publishes, the labels it logs under, the wording of its own
 * activity — arrives as an explicit input. The tolerance does not: the
 * monitor is a witness of a run, not a condition of it. A store that throws
 * is logged and the run carries on, and that rule is written down here
 * instead of being copied into every runner that touches the monitor.
 */

import { logger } from '@afk/infrastructure';
import type { AgentExecution, ExecutionResult } from '../../domain/agents/types.js';
import { runtimeRecord, type RuntimeRecordInput } from './runtime-record.js';
import type {
  TaskRuntimeActivity,
  TaskRuntimeActivityKind,
  TaskRuntimeDiagnostics,
  TaskRuntimePhase,
  TaskRuntimeRecord,
  TaskRuntimeRecordInput,
} from './task-runtime.js';

/** The fields a heartbeat may change on a live record. */
export type RuntimeHeartbeatChanges = Partial<Pick<
  TaskRuntimeRecord,
  | 'phase'
  | 'progress'
  | 'diagnosticPath'
  | 'worktree'
  | 'branch'
  | 'errorSummary'
  | 'agentProvider'
  | 'agentTransport'
  | 'agentAuth'
  | 'agentModelProvider'
  | 'agentThreadId'
>>;

/** The fields an archived record may carry. */
export type RuntimeFinishChanges = Pick<
  Partial<TaskRuntimeRecord>,
  'status' | 'progress' | 'diagnosticPath' | 'errorSummary'
>;

/** The activity a runner appends to its own record. */
export type RuntimeActivityInput = Omit<TaskRuntimeActivity, 'id' | 'taskRunId' | 'at'> & {
  id?: string;
  at?: string;
};

/**
 * The store operations the lifecycle needs — the seam between the lifecycle
 * and the runtime store. `TaskRuntimeManager` satisfies it as it stands, and
 * a test can stand in a store that throws.
 */
export interface RuntimeLifecycleStore {
  start(record: TaskRuntimeRecordInput): Promise<void>;
  heartbeat(runId: string, changes?: RuntimeHeartbeatChanges): Promise<TaskRuntimeRecord>;
  appendActivity(runId: string, activity: RuntimeActivityInput): Promise<TaskRuntimeRecord>;
  finish(runId: string, changes: RuntimeFinishChanges): Promise<TaskRuntimeRecord>;
  writeDiagnostics(runId: string, diagnostics: TaskRuntimeDiagnostics): Promise<string>;
}

/**
 * The log lines a runner uses for the four operations. They are the runner's
 * own words — a workflow run and a QA run are not the same run — and they
 * are the only thing the lifecycle needs to know about the runner that is
 * not about the run itself.
 */
export interface RuntimeLifecycleLabels {
  /** Logged when the record could not be published. */
  publish: string;
  /** Logged when the heartbeat could not be written. */
  heartbeat: string;
  /** Logged when the record could not be archived. */
  archive: string;
  /** Logged when the diagnostics could not be persisted. */
  diagnostics: string;
}

export interface RuntimeLifecycleOptions {
  store: RuntimeLifecycleStore;
  labels: RuntimeLifecycleLabels;
}

export interface RuntimeStartInput {
  runId: string;
  /** The phase this run publishes itself under. */
  phase: TaskRuntimePhase;
  /** The record the runner wants published, minus the fields the lifecycle owns. */
  record: Omit<RuntimeRecordInput, 'runId' | 'phase'>;
}

export interface RuntimeFinishInput {
  status: 'completed' | 'blocked';
  progress: string;
  /** What went wrong, when the runner knows. */
  errorSummary?: string;
  /** What a blocked run records when it has no summary of its own. */
  defaultErrorSummary: string;
}

export interface RuntimeDiagnosticsInput {
  result: ExecutionResult;
  execution: AgentExecution;
  /** The activity a failed run appends. */
  failed: { kind: TaskRuntimeActivityKind; message: string };
  /** The activity a completed run appends. */
  completed: { kind: TaskRuntimeActivityKind; message: string };
}

/**
 * One run's runtime record, from the first heartbeat to the archive.
 *
 * The lifecycle holds the run id, because "is there a run to write to?" is
 * the lifecycle's question and not the runner's: a heartbeat before the run
 * started, or after it finished, has nowhere to go and does nothing.
 */
export class RuntimeLifecycle {
  private readonly store: RuntimeLifecycleStore;
  private readonly labels: RuntimeLifecycleLabels;
  private currentRunId?: string;

  constructor(options: RuntimeLifecycleOptions) {
    this.store = options.store;
    this.labels = options.labels;
  }

  /** The run id of the live record, if the run still has one. */
  get runId(): string | undefined {
    return this.currentRunId;
  }

  /**
   * Forget the run that was here. A new run starts from nothing, even if
   * the run before it never reached its archive.
   */
  reset(): void {
    this.currentRunId = undefined;
  }

  /**
   * Publish the run's record.
   *
   * A record that cannot be published is a monitor that stays empty, not a
   * run that fails: the failure is logged and the run carries on without a
   * record. The record is published once — a run that already has one does
   * not publish it again.
   */
  async start(input: RuntimeStartInput): Promise<void> {
    if (this.currentRunId) return;
    this.currentRunId = input.runId;
    try {
      await this.store.start(runtimeRecord({ ...input.record, runId: input.runId, phase: input.phase }));
    } catch (error) {
      logger.warn({ runId: input.runId, backlogId: input.record.backlogId, error }, this.labels.publish);
      this.currentRunId = undefined;
    }
  }

  /** Tell the monitor the run is still alive. */
  async heartbeat(changes: RuntimeHeartbeatChanges = {}): Promise<void> {
    const runId = this.currentRunId;
    if (!runId) return;
    try {
      await this.store.heartbeat(runId, changes);
    } catch (error) {
      logger.warn({ runId, error }, this.labels.heartbeat);
    }
  }

  /**
   * Archive the record.
   *
   * A blocked run that has no summary of its own records the runner's
   * default, so the monitor never shows a blocked run without a reason. A
   * run that was never published has nothing to archive.
   */
  async finish(input: RuntimeFinishInput): Promise<void> {
    const runId = this.currentRunId;
    if (!runId) return;
    this.currentRunId = undefined;
    try {
      await this.store.finish(runId, {
        status: input.status,
        progress: input.progress,
        errorSummary: input.status === 'blocked' ? input.errorSummary ?? input.defaultErrorSummary : undefined,
      });
    } catch (error) {
      logger.warn({ runId, error }, this.labels.archive);
    }
  }

  /**
   * Write what the run produced and say what happened in its activity log.
   *
   * A run that failed — or that reported `FAIL` — is recorded as an error;
   * a run that passed is recorded under the kind the runner names its own
   * phases with.
   */
  async diagnostics(input: RuntimeDiagnosticsInput): Promise<void> {
    const runId = this.currentRunId;
    if (!runId) return;
    try {
      const output = await input.execution.captureOutput({ lines: 200, history: 2_000 });
      await this.store.writeDiagnostics(runId, { result: input.result, output });
      const structured = input.result.structuredOutput as { result?: string; summary?: string } | undefined;
      const failed = input.result.status !== 'completed' || structured?.result === 'FAIL';
      await this.store.appendActivity(runId, {
        kind: failed ? input.failed.kind : input.completed.kind,
        message: structured?.summary ?? (failed ? input.failed.message : input.completed.message),
      });
    } catch (error) {
      logger.warn({ runId, error }, this.labels.diagnostics);
    }
  }
}
