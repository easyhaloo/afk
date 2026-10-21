import { z } from 'zod';
import {
  GOAL_COMPLETE_RESULTS,
  type GoalCompleteSignal,
  type HandoffReadySignal,
  type IdleSignal,
  type Signal,
  type TimeoutSignal,
} from '@afk/core';

/**
 * The grammar of the signal file.
 *
 * The shapes a signal may take live in the core package, because the
 * runner that writes one, the reader that waits for one and the command
 * that asks for one are three layers. This file is the grammar the file
 * has to satisfy, and it is written against those shapes: a schema that
 * accepted a signal the shapes do not describe would let a file in that
 * no reader of the shapes can make sense of.
 */

export const GoalCompleteSignalSchema = z.object({
  type: z.literal('goal_complete'),
  timestamp: z.string().datetime(),
  kind: z.enum(['task', 'qa', 'ac_verification']).optional(),
  result: z.enum(GOAL_COMPLETE_RESULTS).optional(),
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
}) satisfies z.ZodType<GoalCompleteSignal>;

export const HandoffReadySignalSchema = z.object({
  type: z.literal('handoff_ready'),
  timestamp: z.string().datetime(),
  summary: z.string().min(1, 'Summary is required'),
}) satisfies z.ZodType<HandoffReadySignal>;

export const TimeoutSignalSchema = z.object({
  type: z.literal('timeout'),
  timestamp: z.string().datetime(),
}) satisfies z.ZodType<TimeoutSignal>;

export const IdleSignalSchema = z.object({
  type: z.literal('idle'),
  timestamp: z.string().datetime(),
}) satisfies z.ZodType<IdleSignal>;

export const SignalSchema = z.discriminatedUnion('type', [
  GoalCompleteSignalSchema,
  HandoffReadySignalSchema,
  TimeoutSignalSchema,
  IdleSignalSchema,
]) satisfies z.ZodType<Signal>;

export function getCurrentTimestamp(): string {
  return new Date().toISOString();
}
