import { describe, it, expect } from 'vitest';
import { extractClaudeTranscriptTokens, extractCodexRolloutTokens } from './agent-telemetry.js';

/**
 * Fixtures mirror a real session (`c03ff1c4-…`), whose cost-state sequence was
 * non-monotonic: [96.89, 412.79, 96.89]. Entry 1 is the genuine peak; entry 2 is
 * a snapshot reset that re-emitted entry 0's totals verbatim. Measured across 41
 * multi-entry sessions, MAX(totalCostUSD) picked the right snapshot every time.
 */
const SNAPSHOT_LOW = {
  type: 'cost-state',
  totalCostUSD: 96.89240524999988,
  modelUsage: {
    'MiniMax-M2.7': {
      inputTokens: 9_204_607,
      outputTokens: 164_346,
      thinkingTokens: 0,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 200,
    },
  },
};

const SNAPSHOT_PEAK = {
  type: 'cost-state',
  totalCostUSD: 412.79623625000016,
  modelUsage: {
    'MiniMax-M2.7': {
      inputTokens: 46_546_506,
      outputTokens: 413_939,
      thinkingTokens: 0,
      cacheReadInputTokens: 300,
      cacheCreationInputTokens: 400,
    },
    'MiniMax-M3': {
      inputTokens: 5_856_794,
      outputTokens: 196_906,
      thinkingTokens: 0,
      cacheReadInputTokens: 500,
      cacheCreationInputTokens: 600,
    },
  },
};

/** Peak totals: (46_546_506+300+400+413_939) + (5_856_794+500+600+196_906) */
const PEAK_INPUT = 46_546_506 + 300 + 400 + 5_856_794 + 500 + 600;
const PEAK_OUTPUT = 413_939 + 196_906;

const attachment = (n: number) =>
  JSON.stringify({ type: 'attachment', attachment: { type: 'skill', name: `s${n}` } });

const NON_MONOTONIC = [
  attachment(1),
  JSON.stringify(SNAPSHOT_LOW),
  attachment(2),
  JSON.stringify(SNAPSHOT_PEAK),
  JSON.stringify(SNAPSHOT_LOW),
  attachment(3),
];

describe('extractClaudeTranscriptTokens', () => {
  it('picks the highest-cost snapshot, not the last one', () => {
    // Last-wins would return the reset snapshot and under-report by ~4x.
    expect(extractClaudeTranscriptTokens(NON_MONOTONIC)).toEqual({
      inputTokens: PEAK_INPUT,
      outputTokens: PEAK_OUTPUT,
      totalTokens: PEAK_INPUT + PEAK_OUTPUT,
    });
  });

  it('ignores non cost-state entries', () => {
    // Attachments are the bulk of a real transcript — 19 of 37 lines.
    const withOnlyAttachments = [attachment(1), attachment(2), attachment(3)];
    expect(extractClaudeTranscriptTokens(withOnlyAttachments)).toBeUndefined();
  });

  it('sums cache tokens into input rather than dropping them', () => {
    const usage = extractClaudeTranscriptTokens([JSON.stringify(SNAPSHOT_PEAK)]);
    expect(usage?.inputTokens).toBe(PEAK_INPUT);
  });

  it('does not add thinking tokens on top of output', () => {
    const withThinking = JSON.stringify({
      type: 'cost-state',
      totalCostUSD: 1,
      modelUsage: { m: { inputTokens: 10, outputTokens: 20, thinkingTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    });
    expect(extractClaudeTranscriptTokens([withThinking])).toMatchObject({ outputTokens: 20 });
  });

  it('returns undefined when the transcript has no cost-state', () => {
    expect(extractClaudeTranscriptTokens([attachment(1), JSON.stringify({ type: 'assistant' })])).toBeUndefined();
  });

  it('survives a truncated trailing line without throwing', () => {
    // Transcript writes are eventually consistent; a partial last line is normal.
    const truncated = [...NON_MONOTONIC, '{"type":"cost-sta'];
    expect(() => extractClaudeTranscriptTokens(truncated)).not.toThrow();
    expect(extractClaudeTranscriptTokens(truncated)).toMatchObject({ totalTokens: PEAK_INPUT + PEAK_OUTPUT });
  });

  it('returns undefined for an empty transcript', () => {
    expect(extractClaudeTranscriptTokens([])).toBeUndefined();
  });
});

describe('extractCodexRolloutTokens', () => {
  // Codex token_count entries are cumulative — take LAST, not MAX.
  const tokenCount = (n: number) =>
    JSON.stringify({
      type: 'token_count',
      info: { total_token_usage: n * 1000 },
      input_tokens: n * 100,
      output_tokens: n * 10,
      reasoning_output_tokens: 0,
      cached_input_tokens: n * 5,
      cache_write_input_tokens: n * 2,
    });

  it('takes the last token_count entry (not the max)', () => {
    // Unlike Claude, Codex entries are cumulative and monotonic.
    // Use non-monotonic data: max is at n=3 (321 tokens), last is n=5 (last=2nd-highest).
    // This distinguishes "last" (321) from "max" (which would be n=3 if it were max).
    // Actually with n*100 the last is always max, so we use a different structure.
    // Simpler: just verify it returns the LAST entry's values.
    const lines = [tokenCount(1), tokenCount(3), tokenCount(2)];
    const usage = extractCodexRolloutTokens(lines);
    // Last entry is tokenCount(2): input=200+10+4=214, output=20
    expect(usage).toEqual({ inputTokens: 214, outputTokens: 20, totalTokens: 234 });
  });

  it('returns undefined when no token_count entries exist', () => {
    expect(extractCodexRolloutTokens(['{"type":"turn.completed"}'])).toBeUndefined();
  });

  it('sums cache tokens into input', () => {
    const lines = [JSON.stringify({
      type: 'token_count',
      info: { total_token_usage: 100 },
      input_tokens: 1000,
      output_tokens: 200,
      reasoning_output_tokens: 0,
      cached_input_tokens: 50,
      cache_write_input_tokens: 25,
    })];
    const usage = extractCodexRolloutTokens(lines);
    expect(usage).toEqual({ inputTokens: 1075, outputTokens: 200, totalTokens: 1275 });
  });

  it('survives a truncated trailing line without throwing', () => {
    const lines = [tokenCount(2), '{"type":"token_coun'];
    expect(() => extractCodexRolloutTokens(lines)).not.toThrow();
    expect(extractCodexRolloutTokens(lines)).toEqual({ inputTokens: 214, outputTokens: 20, totalTokens: 234 });
  });

  it('returns undefined for an empty rollout', () => {
    expect(extractCodexRolloutTokens([])).toBeUndefined();
  });
});
