import { describe, expect, it } from 'vitest';
import { codexTokenUsage } from './codex-usage.js';

describe('codexTokenUsage', () => {
  const snapshot = { input_tokens: 52734, cached_input_tokens: 32640, output_tokens: 182 };

  it('derives the exec total from inclusive input and output', () => {
    expect(codexTokenUsage(snapshot)).toEqual({ inputTokens: 52734, outputTokens: 182, totalTokens: 52916 });
  });

  it('preserves a reported total if the breakdown is incomplete', () => {
    expect(codexTokenUsage({ output_tokens: 182, total_tokens: 52916 }))
      .toEqual({ inputTokens: 0, outputTokens: 182, totalTokens: 52916 });
  });
});
