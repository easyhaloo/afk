/**
 * Prompt budget — what a provider can actually accept.
 *
 * A provider's TUI refuses a `/goal` condition that is too long and then
 * does nothing at all: no task, no output, no error the runner can see. AFK
 * only learns about it when the idle timeout expires, half an hour later,
 * and the failure is recorded as "the agent was silent" — which is a
 * symptom, not the cause.
 *
 * So the limit is measured before the prompt is dispatched, and the provider
 * is asked what it accepts. Two rules make the measurement honest:
 *
 * - The limit belongs to the *goal channel* only. A prompt delivered as an
 *   ordinary message (batch mode strips the `/goal` command) has no such
 *   limit, and must not be measured against one.
 * - A provider that declares no limit is measured against the strictest
 *   limit AFK knows of. Refusing a goal that might have been accepted costs
 *   one clear message; dispatching a goal that is refused costs the whole
 *   idle timeout.
 */

import type { AgentPromptLimits } from './types.js';

/**
 * The strictest goal-condition limit AFK knows of.
 *
 * Used for a provider that declares no limit of its own. It is the limit
 * Claude Code's TUI enforces on a `/goal` condition, and the smallest one
 * observed across the providers AFK drives.
 */
export const DEFAULT_GOAL_CONDITION_MAX_CHARS = 4000;

/** One labelled piece of a prompt. */
export interface PromptPart {
  /** What the piece is, e.g. `goal task statement`. */
  label: string;
  /** The text of the piece, as it appears in the prompt. */
  text: string;
}

/** The result of measuring a prompt against a provider's goal budget. */
export interface PromptBudget {
  /** The limit that applies to this prompt, when one applies. */
  limit?: number;
  /** True when a limit applies to this prompt at all. */
  applies: boolean;
  /** The length of the goal condition, in characters. */
  actual: number;
  /** How many characters over the limit; 0 when the prompt fits. */
  overBy: number;
  /** True when the provider would refuse this prompt. */
  exceeded: boolean;
  /** The part whose addition crossed the limit. */
  exceededByPart?: string;
  /** Every part with its length, in prompt order. */
  parts: { label: string; chars: number }[];
}

/**
 * The goal condition of a prompt: the text that follows the `/goal` command.
 *
 * Undefined when the prompt is not a goal command, which is the case for
 * every prompt delivered as an ordinary message.
 */
export function goalConditionText(prompt: string): string | undefined {
  const trimmed = prompt.trimStart();
  if (!/^\/goal\b/i.test(trimmed)) return undefined;
  return trimmed.replace(/^\/goal\s*/i, '');
}

/**
 * True when the prompt is delivered through the provider's goal channel.
 *
 * This is the condition under which the goal-condition limit applies: the
 * TUI reads everything after `/goal` as the goal condition and refuses it
 * when it is too long.
 */
export function usesGoalChannel(prompt: string): boolean {
  return goalConditionText(prompt) !== undefined;
}

/**
 * The limit a provider accepts for a goal condition.
 *
 * A provider that declares its own limit gets that limit. A provider that
 * declares none gets {@link DEFAULT_GOAL_CONDITION_MAX_CHARS}: the strictest
 * limit AFK knows of. The default is deliberately pessimistic — a provider
 * that would have accepted a longer goal loses one prompt, while a provider
 * that would have refused it loses thirty minutes of idle timeout.
 */
export function resolveGoalConditionLimit(limits?: AgentPromptLimits): number {
  const declared = limits?.goalConditionMaxChars;
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) {
    return DEFAULT_GOAL_CONDITION_MAX_CHARS;
  }
  return Math.floor(declared);
}

/**
 * The prompt was refused before dispatch because it exceeds the provider's
 * goal budget.
 *
 * Carries the measurement, so the caller can report the actual length, the
 * limit and the part that was responsible without measuring again.
 */
export class PromptBudgetExceededError extends Error {
  readonly budget: PromptBudget;

  constructor(budget: PromptBudget) {
    super(
      `the goal condition is ${budget.actual} characters, over the provider's ${budget.limit}-character goal limit`
      + (budget.exceededByPart === undefined ? '' : ` (the '${budget.exceededByPart}' part is responsible)`),
    );
    this.name = 'PromptBudgetExceededError';
    this.budget = budget;
  }
}

/**
 * Measure a prompt against the goal-condition budget.
 *
 * The measurement is exact for the length: `actual` is the character count
 * of the goal condition the provider would read. The attribution to a part
 * is approximate to within the separators between the parts, which is
 * accurate enough to say which piece of the prompt is responsible.
 */
export function measurePromptBudget(input: {
  /** The final prompt, as it is handed to the provider. */
  prompt: string;
  /** The prompt's pieces, in prompt order. */
  parts?: readonly PromptPart[];
  /** The limits the provider declares. */
  limits?: AgentPromptLimits;
}): PromptBudget {
  const parts = (input.parts ?? []).map(part => ({ label: part.label, chars: part.text.length }));
  const condition = goalConditionText(input.prompt);
  if (condition === undefined) {
    // Not a goal command: no goal-condition limit applies to this prompt.
    return { applies: false, actual: input.prompt.length, overBy: 0, exceeded: false, parts };
  }
  const limit = resolveGoalConditionLimit(input.limits);
  const actual = condition.length;
  const overBy = Math.max(0, actual - limit);
  const exceeded = overBy > 0;
  let cumulative = 0;
  let exceededByPart: string | undefined;
  for (const part of parts) {
    cumulative += part.chars;
    if (exceeded && cumulative > limit && exceededByPart === undefined) exceededByPart = part.label;
  }
  return {
    limit,
    applies: true,
    actual,
    overBy,
    exceeded,
    ...(exceededByPart === undefined ? {} : { exceededByPart }),
    parts,
  };
}
