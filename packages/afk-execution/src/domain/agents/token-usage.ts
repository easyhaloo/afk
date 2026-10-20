import type { TokenUsage } from './types.js';

/**
 * A usage payload as an agent CLI sends it.
 */
type UsagePayload = Record<string, unknown>;

/**
 * The spellings that mean the same number.
 *
 * The agent CLIs do not agree on the spelling: the Codex app server says
 * `input_tokens`, the common stream-json shape says `inputTokens`, and AFK's
 * own statusline reader says `input`. A payload carries one of them, so the
 * first key that holds a number is the one that counts.
 */
export type UsageSpellings = readonly string[];

/**
 * One quantity of a payload, read as the sum of its contributions.
 *
 * Most quantities are one contribution — the number under whichever spelling
 * the CLI used. A CLI that splits a quantity across several keys says so
 * with several contributions: Claude Code sends `input_tokens` *excluding*
 * the cache and puts `cache_creation_input_tokens` and
 * `cache_read_input_tokens` beside it, and the cache is input.
 */
export type UsageQuantity = readonly UsageSpellings[];

/**
 * How to read one CLI's usage payload.
 *
 * A provider declares what its own CLI means; this module does the reading,
 * so the rules live in one place instead of in each provider's cast.
 */
export type TokenUsageReading = {
  /** The input tokens. */
  input: UsageQuantity;
  /** The output tokens. */
  output: UsageQuantity;
  /** The total, when the payload carries one. The sum of input and output is used otherwise. */
  total?: UsageSpellings;
};

/**
 * The spelling an agent CLI uses when it follows the common convention.
 *
 * The three spellings of each number are alternatives of one another, not
 * contributions: a payload carries one of them, so each quantity is a single
 * contribution over all three spellings.
 */
export const COMMON_TOKEN_USAGE: TokenUsageReading = {
  input: [['inputTokens', 'input_tokens', 'input']],
  output: [['outputTokens', 'output_tokens', 'output']],
  total: ['totalTokens', 'total_tokens', 'total'],
};

/**
 * The number a key holds, when it holds one that can be counted.
 *
 * A token count is a whole, non-negative number. A key that holds anything
 * else holds something we do not understand, and it counts for nothing —
 * reading it as zero would report a number the CLI never sent.
 */
function count(usage: UsagePayload, key: string): number | undefined {
  const value = usage[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** The number a set of alternative spellings holds. */
function spelled(usage: UsagePayload, keys: UsageSpellings): number | undefined {
  for (const key of keys) {
    const value = count(usage, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The sum of the contributions that hold a number, or nothing when none does. */
function summed(usage: UsagePayload, quantity: UsageQuantity): number | undefined {
  let total = 0;
  let found = false;
  for (const spellings of quantity) {
    const value = spelled(usage, spellings);
    if (value === undefined) continue;
    total += value;
    found = true;
  }
  return found ? total : undefined;
}

/**
 * Read a usage payload.
 *
 * The total is the sum of the input and the output unless the payload
 * carries one of its own. A payload that holds no number at all is not a
 * usage payload: the answer is nothing, because a usage event whose numbers
 * are missing reaches the token budget as `undefined` and the budget
 * rejects it.
 */
export function parseTokenUsage(raw: unknown, reading: TokenUsageReading): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const usage = raw as UsagePayload;

  const input = summed(usage, reading.input);
  const output = summed(usage, reading.output);
  const stated = reading.total ? spelled(usage, reading.total) : undefined;
  if (input === undefined && output === undefined && stated === undefined) return undefined;

  const inputTokens = input ?? 0;
  const outputTokens = output ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: stated ?? inputTokens + outputTokens,
  };
}
