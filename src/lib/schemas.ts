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
 * NOTE: Result fields below are advisory only — the agent is the
 * evaluated party, not the evaluator. WorkflowRunner.verifyAC()
 * performs objective verification (commit count, AC items present)
 * and treats this signal's `result` as a hint, never as a gate.
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
 * Signal emitted when agent suspects context is high.
 *
 * NOTE: Agent only acts as a trigger. The WorkflowRunner verifies
 * objectively via `getContextTokens()` (parses Claude pane output)
 * and ignores this signal if tokens are below `CONTEXT_HIGH_THRESHOLD`.
 * This avoids the "optimistic reporter" anti-pattern where the
 * evaluated party judges itself.
 */
export const ContextHighSignalSchema = z.object({
  type: z.literal('context_high'),
  timestamp: z.string().datetime(),
});

export type ContextHighSignal = z.infer<typeof ContextHighSignalSchema>;

/**
 * Union of all signal types
 */
export const SignalSchema = z.discriminatedUnion('type', [
  GoalCompleteSignalSchema,
  ACResultSignalSchema,
  HandoffReadySignalSchema,
  TimeoutSignalSchema,
  IdleSignalSchema,
  ContextHighSignalSchema,
]);

export type Signal = z.infer<typeof SignalSchema>;

/**
 * Get current ISO timestamp
 */
export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}
