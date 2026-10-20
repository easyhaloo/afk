import { describe, expect, it } from 'vitest';
import { COMMON_TOKEN_USAGE, parseTokenUsage } from './token-usage.js';

describe('token usage reading', () => {
  it('reads the common spelling', () => {
    expect(parseTokenUsage({ inputTokens: 1, outputTokens: 2, totalTokens: 3 }, COMMON_TOKEN_USAGE)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });

  it('sums the total when the payload carries none', () => {
    expect(parseTokenUsage({ inputTokens: 1, outputTokens: 2 }, COMMON_TOKEN_USAGE)).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      totalTokens: 3,
    });
  });

  it('reads the other spelling of each number', () => {
    expect(parseTokenUsage({ input: 10, output: 5, total: 15 }, COMMON_TOKEN_USAGE)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('reads the snake_case spelling of each number', () => {
    expect(parseTokenUsage({ input_tokens: 10, output_tokens: 5 }, COMMON_TOKEN_USAGE)).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('reports nothing for a payload that holds no number', () => {
    expect(parseTokenUsage({ note: 'unknown' }, COMMON_TOKEN_USAGE)).toBeUndefined();
    expect(parseTokenUsage({}, COMMON_TOKEN_USAGE)).toBeUndefined();
  });

  it('reports nothing for a payload that is not a payload', () => {
    expect(parseTokenUsage(undefined, COMMON_TOKEN_USAGE)).toBeUndefined();
    expect(parseTokenUsage('usage', COMMON_TOKEN_USAGE)).toBeUndefined();
    expect(parseTokenUsage([1, 2], COMMON_TOKEN_USAGE)).toBeUndefined();
  });

  it('counts nothing for a number that is not a whole count', () => {
    expect(parseTokenUsage({ inputTokens: 1.5, outputTokens: 2 }, COMMON_TOKEN_USAGE)).toEqual({
      inputTokens: 0,
      outputTokens: 2,
      totalTokens: 2,
    });
    expect(parseTokenUsage({ inputTokens: -1, outputTokens: 2 }, COMMON_TOKEN_USAGE)).toEqual({
      inputTokens: 0,
      outputTokens: 2,
      totalTokens: 2,
    });
  });

  it('takes the first spelling that holds a number, not the sum of them', () => {
    expect(parseTokenUsage({ inputTokens: 4, input: 40, outputTokens: 6 }, COMMON_TOKEN_USAGE)).toEqual({
      inputTokens: 4,
      outputTokens: 6,
      totalTokens: 10,
    });
  });

  it('reads a quantity a CLI splits across several keys', () => {
    // Claude Code sends input_tokens *excluding* the cache and puts the cache
    // tokens beside it; the cache is input.
    const reading = {
      input: [['input_tokens'], ['cache_creation_input_tokens'], ['cache_read_input_tokens']],
      output: [['output_tokens']],
    };

    expect(parseTokenUsage({
      input_tokens: 5252,
      cache_creation_input_tokens: 20569,
      cache_read_input_tokens: 0,
      output_tokens: 120,
    }, reading)).toEqual({ inputTokens: 25821, outputTokens: 120, totalTokens: 25941 });
  });

  it('reports numbers the token budget accepts', () => {
    const usage = parseTokenUsage({ inputTokens: 4, outputTokens: 6 }, COMMON_TOKEN_USAGE);
    expect(usage).toBeDefined();
    for (const value of [usage!.inputTokens, usage!.outputTokens, usage!.totalTokens]) {
      expect(Number.isSafeInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
