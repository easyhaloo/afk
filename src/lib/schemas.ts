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
 * Signal emitted after running acceptance criteria checks
 */
export const ACResultSignalSchema = z.object({
  type: z.literal('ac_result'),
  timestamp: z.string().datetime(),
  result: z.enum(['PASS', 'FAIL']),
  summary: z.string().min(1, 'Summary is required'),
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
 * Union of all signal types
 */
export const SignalSchema = z.discriminatedUnion('type', [
  GoalCompleteSignalSchema,
  ACResultSignalSchema,
  HandoffReadySignalSchema,
]);

export type Signal = z.infer<typeof SignalSchema>;

/**
 * Get current ISO timestamp
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}
