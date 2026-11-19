import type { TokenUsage } from './types.js';

export function codexTokenUsage(snapshot: Record<string, unknown>): TokenUsage {
  const { input_tokens, output_tokens, total_tokens } = snapshot;
  const inputTokens = typeof input_tokens === 'number' && Number.isFinite(input_tokens) ? input_tokens : 0;
  const outputTokens = typeof output_tokens === 'number' && Number.isFinite(output_tokens) ? output_tokens : 0;
  const totalTokens = typeof total_tokens === 'number' && Number.isFinite(total_tokens) ? total_tokens : inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}
