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

  /** Timeout for AC result signal (3 minutes) */
  AC_SIGNAL_TIMEOUT: 3 * 60 * 1000, // 180000ms

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
 * Port numbers for services
 */
export const PORTS = {
  /** Default Redis port */
  REDIS_DEFAULT: 6379,

  /** MinIO base port */
  MINIO_BASE: 9000,

  /** MinIO console port */
  MINIO_CONSOLE: 9001,
} as const;

/**
 * Retry configuration
 */
export const RETRY = {
  /** Maximum number of retry attempts */
  MAX_ATTEMPTS: 3,

  /** Initial backoff delay in milliseconds */
  BACKOFF_MS: 1000,
} as const;

/**
 * Time conversion constants
 */
export const TIME = {
  /** Milliseconds per second */
  MS_PER_SECOND: 1000,

  /** Milliseconds per minute */
  MS_PER_MINUTE: 60 * 1000,

  /** Milliseconds per hour */
  MS_PER_HOUR: 60 * 60 * 1000,

  /** Milliseconds per day */
  MS_PER_DAY: 24 * 60 * 60 * 1000,
} as const;
