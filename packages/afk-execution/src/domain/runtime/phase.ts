/**
 * The phases a task runtime record can be in.
 *
 * The rule lives in the execution package's domain layer, beside the
 * tmux session naming rule, because the desktop's renderer reads the
 * same records and the domain layer is the only part of this package a
 * renderer can load. The records themselves live in the application
 * layer, where the files are read and written.
 */
export const TASK_RUNTIME_PHASES = ['implementing', 'verifying'] as const;

export type TaskRuntimePhase = (typeof TASK_RUNTIME_PHASES)[number];
