import type {
  ActiveTaskRuntimeRecord,
  RuntimeRecordEntry,
  RuntimeRecordIdentity,
  RuntimeRecordQuery,
  TaskRuntimeRecord,
} from '@afk/core';

/**
 * The records of the runs the runtime is tracking.
 *
 * The runtime writes them; the board lists them, the desktop reads the
 * ones behind a work item, and the command that stops a run finds the run
 * it is stopping. They are the runtime's own records, and reading them is
 * a capability of the runtime rather than a thing each reader does for
 * itself: a reader that opened the files itself would have to know the
 * bucket layout, the file names and the identity rule, and two readers
 * that each knew them could disagree about which records a run has.
 */
export interface TaskRuntimePort {
  /** The records of the runs that are still going. */
  listActive(): Promise<readonly ActiveTaskRuntimeRecord[]>;
  /** The records of the runs that have finished. */
  listArchive(): Promise<readonly TaskRuntimeRecord[]>;
  /** The records of the runs matching a work item, newest heartbeat first. */
  list(query?: RuntimeRecordQuery): Promise<readonly RuntimeRecordEntry[]>;
  /** The record of one run: the active one wins over the archived one. */
  find(runId: string, identity?: RuntimeRecordIdentity): Promise<RuntimeRecordEntry | undefined>;
}
