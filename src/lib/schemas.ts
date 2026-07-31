import { z } from 'zod';

/**
 * Signal emitted when agent completes a goal
 */
export const GoalCompleteSignalSchema = z.object({
  type: z.literal('goal_complete'),
  timestamp: z.string().datetime(),
  sha: z.string().optional(),
  summary: z.string().min(1, 'Summary is required'),
});

export type GoalCompleteSignal = z.infer<typeof GoalCompleteSignalSchema>;

/**
 * Signal emitted after agent runs AC checks.
 *
 * In the two-phase design, Phase 2 (Verify) sends a /goal to the agent
 * to verify AC, and the agent writes this signal on completion. The
 * result fields are advisory — QARunner provides independent verification.
 */
export const ACResultSignalSchema = z.object({
  type: z.literal('ac_result'),
  timestamp: z.string().datetime(),
  result: z.enum(['PASS', 'FAIL']).optional(),
  summary: z.string().optional(),
  tests_run: z.number().int().nonnegative().optional(),
  tests_passed: z.number().int().nonnegative().optional(),
});

export type ACResultSignal = z.infer<typeof ACResultSignalSchema>;

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
  ACResultSignalSchema,
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
