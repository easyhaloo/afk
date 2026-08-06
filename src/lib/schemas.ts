import { z } from 'zod';

/**
 * Signal emitted when agent completes a goal
 */
export const GoalCompleteSignalSchema = z.object({
  type: z.literal('goal_complete'),
  timestamp: z.string().datetime(),
  kind: z.enum(['task', 'qa', 'ac_verification']).optional(),
  result: z.enum(['PASS', 'FAIL']).optional(),
  sha: z.string().optional(),
  summary: z.string().min(1, 'Summary is required'),
  tests_run: z.number().int().nonnegative().optional(),
  tests_passed: z.number().int().nonnegative().optional(),
  failedCriteria: z.array(z.object({
    id: z.string().min(1),
    expected: z.string().min(1),
    actual: z.string().min(1),
  })).optional(),
  requiredChecks: z.array(z.object({
    command: z.string().min(1),
    expected: z.string().min(1),
  })).optional(),
});

export type GoalCompleteSignal = z.infer<typeof GoalCompleteSignalSchema>;

/**
 * Signal emitted when agent is ready for context handoff
 */
export const HandoffReadySignalSchema = z.object({
  type: z.literal('handoff_ready'),
  timestamp: z.string().datetime(),
  summary: z.string().min(1, 'Summary is required'),
});

export type HandoffReadySignal = z.infer<typeof HandoffReadySignalSchema>;

/**
 * Signal emitted when hard timeout watchdog fires
 */
export const TimeoutSignalSchema = z.object({
  type: z.literal('timeout'),
  timestamp: z.string().datetime(),
});

export type TimeoutSignal = z.infer<typeof TimeoutSignalSchema>;

/**
 * Signal emitted when agent detects itself idle
 */
export const IdleSignalSchema = z.object({
  type: z.literal('idle'),
  timestamp: z.string().datetime(),
});

export type IdleSignal = z.infer<typeof IdleSignalSchema>;

/**
 * Union of all signal types
 *
 * Note: context overflow is NOT a signal. The runner is the sole authority,
 * polling `<worktree>/.afk/claude-status.json` (written by Claude Code's
 * statusline) against `CONTEXT.HIGH_THRESHOLD` — the agent cannot reliably
 * detect its own context limit, so it never reports one.
 */
export const SignalSchema = z.discriminatedUnion('type', [
  GoalCompleteSignalSchema,
  HandoffReadySignalSchema,
  TimeoutSignalSchema,
  IdleSignalSchema,
]);

export type Signal = z.infer<typeof SignalSchema>;

/**
 * Get current ISO timestamp
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}
