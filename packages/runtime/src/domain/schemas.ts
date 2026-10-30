import { z } from 'zod';

/**
 * Signal timestamps are written by the agent, not by AFK.
 *
 * Agents reach for whatever their language produces: JavaScript's
 * `toISOString()` yields a `Z` suffix, Python's
 * `datetime.now(timezone.utc).isoformat()` yields a `+00:00` offset. A
 * schema that only accepts `Z` silently rejects the Python form, the
 * completion signal never validates, and the run hangs until the completion
 * timeout — with no error to explain why. `offset: true` accepts both.
 */
export const SignalTimestampSchema = z.string().datetime({ offset: true });

export const GoalCompleteSignalSchema = z.object({
  type: z.literal('goal_complete'),
  timestamp: SignalTimestampSchema,
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

export const HandoffReadySignalSchema = z.object({
  type: z.literal('handoff_ready'),
  timestamp: SignalTimestampSchema,
  summary: z.string().min(1, 'Summary is required'),
});

export type HandoffReadySignal = z.infer<typeof HandoffReadySignalSchema>;

export const TimeoutSignalSchema = z.object({
  type: z.literal('timeout'),
  timestamp: SignalTimestampSchema,
});

export type TimeoutSignal = z.infer<typeof TimeoutSignalSchema>;

export const IdleSignalSchema = z.object({
  type: z.literal('idle'),
  timestamp: SignalTimestampSchema,
});

export type IdleSignal = z.infer<typeof IdleSignalSchema>;

export const SignalSchema = z.discriminatedUnion('type', [
  GoalCompleteSignalSchema,
  HandoffReadySignalSchema,
  TimeoutSignalSchema,
  IdleSignalSchema,
]);

export type Signal = z.infer<typeof SignalSchema>;

export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}
