/**
 * Scheduler-only compile-time constants.
 *
 * All workflow values are sourced from WorkflowConfig via getWorkflowConfig().
 * Import config functions from '../infrastructure/config/manager' instead.
 *
 * This file is kept minimal: only values that are truly scheduler/isolator
 * internal and have no counterpart in any Config interface.
 */

/**
 * Scheduler retry / delay constants.
 */
export const TIMEOUTS = {
  /** Job retry delay (1 minute) */
  JOB_RETRY_DELAY: 1 * 60 * 1000,

  /** Job delay for rescheduling (1 hour) */
  JOB_RESCHEDULE_DELAY: 1 * 60 * 60 * 1000,

  /** Default tmux session wait timeout (2 hours) — used by TmuxClient methods */
  TMUX_SESSION_TIMEOUT: 2 * 60 * 60 * 1000,
} as const;

/**
 * MinIO / service port numbers.
 */
export const PORTS = {
  MINIO_BASE: 9000,
  MINIO_CONSOLE: 9001,
} as const;
