/**
 * Application-wide constants
 *
 * Workflow-related values are sourced from config; scheduler/scheduler-only
 * values remain here as compile-time constants.
 */

import { getWorkflowConfig } from './core/config/manager';

/**
 * Timeout values used by the scheduler and QA runner (not workflow runtime).
 * Workflow timeouts are read from WorkflowConfig at run time.
 */
export const TIMEOUTS = {
  /** Job retry delay (1 minute) */
  JOB_RETRY_DELAY: 1 * 60 * 1000, // 60000ms

  /** Job delay for rescheduling (1 hour) */
  JOB_RESCHEDULE_DELAY: 1 * 60 * 60 * 1000, // 3600000ms

  /** Default tmux session wait timeout (2 hours) */
  TMUX_SESSION_TIMEOUT: 2 * 60 * 60 * 1000, // 7200000ms

  /** Completion timeout for workflow (2 hours) — CLI/QA fallback */
  WORKFLOW_COMPLETION_TIMEOUT: 2 * 60 * 60 * 1000, // 7200000ms

  /** Hard timeout for workflow (2 hours) — CLI fallback */
  WORKFLOW_HARD_TIMEOUT: 2 * 60 * 60 * 1000, // 7200000ms
} as const;

export const CONTEXT = {
  HIGH_THRESHOLD: 100_000,
} as const;

/**
 * Context threshold — sourced from WorkflowConfig at runtime.
 */
export function getContextHighThreshold(): number {
  return getWorkflowConfig().contextThreshold;
}

/**
 * Compile-time fallback for CLI defaults (not env-driven).
 * Runtime: use getContextHighThreshold() instead.
 */
export const CONTEXT_HIGH_THRESHOLD = 100_000;

/**
 * Max automatic context-handoff rounds — read from WorkflowConfig at runtime.
 * Falls back to 3 when called before config is loaded.
 */
export function getMaxHandoffs(): number {
  const gb = getWorkflowConfig().goalBudget;
  return gb > 0 ? Math.min(Math.ceil(gb / 1_000_000), 20) : 3;
}

/**
 * Compile-time fallback for CLI defaults (not env-driven).
 * Runtime: use getMaxHandoffs() instead.
 */
export const MAX_HANDOFFS = 3;

/**
 * Max total tokens across handoff generations — read from WorkflowConfig at runtime.
 * Falls back to 500_000 when called before config is loaded.
 */
export function getMaxTotalTokens(): number {
  return getWorkflowConfig().goalBudget || 500_000;
}

/**
 * Compile-time fallback for CLI defaults (not env-driven).
 * Runtime: use getMaxTotalTokens() instead.
 */
export const MAX_TOTAL_TOKENS = 500_000;

/**
 * Workflow timeouts — sourced from WorkflowConfig at runtime.
 */
export function getWorkflowHardTimeout(): number {
  return getWorkflowConfig().workflowHardTimeout;
}

export function getWorkflowCompletionTimeout(): number {
  return getWorkflowConfig().completionTimeout;
}
export const PORTS = {
  /** MinIO base port */
  MINIO_BASE: 9000,

  /** MinIO console port */
  MINIO_CONSOLE: 9001,
} as const;
