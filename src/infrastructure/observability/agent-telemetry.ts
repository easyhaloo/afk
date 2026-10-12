/**
 * Agent telemetry readers.
 *
 * Pure functions over transcript/rollout data — zero I/O, fully testable
 * with fixtures. Thin I/O wrappers (file reading) live at call sites.
 *
 * Boundary: harness owns agent-layer truth. AFK only READS.
 */

import type { TokenUsage } from '../../domain/agents/types.js';

/** Claude Code cost-state entry (from transcript .jsonl). */
interface CostStateEntry {
  type: 'cost-state';
  totalCostUSD: number;
  modelUsage: Record<string, {
    inputTokens: number;
    outputTokens: number;
    thinkingTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  }>;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Extract token usage from a Claude Code transcript (JSONL lines).
 *
 * Across 41 real multi-entry sessions the cost-state sequence was
 * non-monotonic: [96.89, 412.79, 96.89]. The third entry is a snapshot
 * reset that re-emitted the first totals verbatim. MAX(totalCostUSD)
 * picked the genuine peak 41/41 times. Last-wins is wrong.
 *
 * `thinking_tokens` is a breakdown OF `output_tokens`, never additional.
 * Cache tokens are summed into input (Claude reports input EXCLUDING cache).
 */
export function extractClaudeTranscriptTokens(lines: string[]): TokenUsage | undefined {
  let peak: CostStateEntry | undefined;

  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Truncated or non-JSON line — skip
      continue;
    }
    if (!isCostStateEntry(parsed)) continue;
    if (peak === undefined || parsed.totalCostUSD > peak.totalCostUSD) {
      peak = parsed;
    }
  }

  if (!peak) return undefined;

  let inputTokens = 0;
  let outputTokens = 0;

  for (const model of Object.values(peak.modelUsage)) {
    inputTokens += num(model.inputTokens) + num(model.cacheReadInputTokens) + num(model.cacheCreationInputTokens);
    outputTokens += num(model.outputTokens); // thinkingTokens already included in outputTokens
  }

  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function isCostStateEntry(v: unknown): v is CostStateEntry {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'cost-state' &&
    typeof (v as CostStateEntry).totalCostUSD === 'number' &&
    typeof (v as CostStateEntry).modelUsage === 'object'
  );
}

/** Codex token_count entry (from rollout .jsonl). */
interface TokenCountEntry {
  type: 'token_count';
  info: { total_token_usage: number };
  input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
}

/**
 * Extract token usage from a Codex rollout transcript (JSONL lines).
 *
 * Unlike Claude Code, Codex token_count entries are cumulative and
 * monotonic — take the LAST one. Do NOT use MAX here.
 */
export function extractCodexRolloutTokens(lines: string[]): TokenUsage | undefined {
  let last: TokenCountEntry | undefined;

  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isTokenCountEntry(parsed)) continue;
    last = parsed;
  }

  if (!last) return undefined;

  const inputTokens =
    num(last.input_tokens) + num(last.cached_input_tokens) + num(last.cache_write_input_tokens);
  const outputTokens = num(last.output_tokens); // reasoning_output_tokens already in output_tokens

  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function isTokenCountEntry(v: unknown): v is TokenCountEntry {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'token_count' &&
    typeof (v as TokenCountEntry).info?.total_token_usage === 'number'
  );
}
