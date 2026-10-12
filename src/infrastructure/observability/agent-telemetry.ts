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

/** Parameters for readAgentTelemetry. */
export interface ReadTelemetryOptions {
  provider: 'claude-code' | 'codex';
  transcriptPath: string;
  sandboxKind: 'local' | 'container';
}

/**
 * Read token usage from a harness transcript file.
 *
 * Returns undefined for container sandboxes (HOME not forwarded, harness
 * directories not mounted) and when the file does not exist.
 * Never returns NaN — uses num() for every field.
 */
export async function readAgentTelemetry(options: ReadTelemetryOptions): Promise<TokenUsage | undefined> {
  const { provider, transcriptPath, sandboxKind } = options;

  if (sandboxKind === 'container') {
    // HOME is excluded from container env; harness dirs are not mounted.
    return undefined;
  }

  let content: string;
  try {
    const { readFileSync } = await import('node:fs');
    content = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return undefined;
  }

  const lines = content.split('\n').filter(l => l.trim());
  if (provider === 'claude-code') return extractClaudeTranscriptTokens(lines);
  return extractCodexRolloutTokens(lines);
}

/**
 * Locate a Codex rollout file by thread_id suffix glob.
 *
 * Filename format: rollout-<local-time>-<thread_id>.jsonl
 * thread_id is the only stable key — do NOT derive path from timestamps
 * (filename uses local clock, session_meta uses UTC, differ by hours).
 *
 * @param threadId  The thread_id to match (filename suffix, not a full path).
 * @param rootDir   Optional root to search. Defaults to the real homedir().
 *                   Use this for testing with fixture directories.
 */
export async function findCodexRollout(threadId: string, rootDir?: string): Promise<string | undefined> {
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');

  const sessionsRoot = join(rootDir ?? homedir(), '.codex', 'sessions');

  let sessionsYearDirs: string[];
  try {
    sessionsYearDirs = readdirSync(sessionsRoot);
  } catch {
    return undefined;
  }

  for (const yearDir of sessionsYearDirs) {
    let monthDirs: string[];
    try {
      monthDirs = readdirSync(join(sessionsRoot, yearDir));
    } catch {
      continue;
    }
    for (const monthDir of monthDirs) {
      let dayDirs: string[];
      try {
        dayDirs = readdirSync(join(sessionsRoot, yearDir, monthDir));
      } catch {
        continue;
      }
      for (const dayDir of dayDirs) {
        const dayPath = join(sessionsRoot, yearDir, monthDir, dayDir);
        let files: string[];
        try {
          files = readdirSync(dayPath);
        } catch {
          continue;
        }
        for (const file of files) {
          if (file.endsWith(`-${threadId}.jsonl`) && file.startsWith('rollout-')) {
            return join(dayPath, file);
          }
        }
      }
    }
  }

  return undefined;
}
