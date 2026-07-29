/**
 * Application-wide constants
 *
 * This file centralizes magic numbers and strings to improve maintainability.
 */

/**
 * Timeout values in milliseconds
 */
export const TIMEOUTS = {
  /** Hard timeout for workflow execution (2 hours) */
  WORKFLOW_HARD_TIMEOUT: 2 * 60 * 60 * 1000, // 7200000ms

  /** Completion timeout for workflow (2 hours) */
  WORKFLOW_COMPLETION_TIMEOUT: 2 * 60 * 60 * 1000, // 7200000ms

  /** Timeout for handoff ready signal (1 minute) */
  HANDOFF_TIMEOUT: 1 * 60 * 1000, // 60000ms

  /** Default tmux session wait timeout (2 hours) */
  TMUX_SESSION_TIMEOUT: 2 * 60 * 60 * 1000, // 7200000ms

  /** Job retry delay (1 minute) */
  JOB_RETRY_DELAY: 1 * 60 * 1000, // 60000ms

  /** Job delay for rescheduling (1 hour) */
  JOB_RESCHEDULE_DELAY: 1 * 60 * 60 * 1000, // 3600000ms
} as const;

/**
 * Context monitoring thresholds (tokens)
 */
export const CONTEXT = {
  /**
   * Threshold to trigger handoff flow when agent reports context_high.
   * Below this, the signal is ignored (agent probably being cautious).
   * Set to ~50% of Claude's 200K context window as a conservative cutoff.
   */
  HIGH_THRESHOLD: 100_000,
} as const;

/**
 * Port numbers for services
 */
export const PORTS = {
  /** MinIO base port */
  MINIO_BASE: 9000,

  /** MinIO console port */
  MINIO_CONSOLE: 9001,
} as const;
