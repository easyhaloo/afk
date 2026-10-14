/**
 * Agent telemetry readers.
 *
 * Pure functions over transcript/rollout data — zero I/O, fully testable
 * with fixtures. Thin I/O wrappers (file reading) live at call sites.
 *
 * Boundary: harness owns agent-layer truth. AFK only READS.
 */

import type { AgentToolCallSummary } from '@afk/core';
import type { TokenUsage } from '../../domain/agents/types.js';
import { extractClaudeToolEvents, extractCodexToolEvents } from '../../domain/agents/tool-telemetry.js';
export { extractClaudeToolEvents, extractCodexToolEvents } from '../../domain/agents/tool-telemetry.js';

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

/** Codex token_count entry nested inside an event_msg payload (from rollout .jsonl). */
interface TokenCountPayload {
  type: 'token_count';
  info: {
    total_token_usage: {
      input_tokens: number;
      output_tokens: number;
      reasoning_output_tokens: number;
      cached_input_tokens: number;
      cache_write_input_tokens: number;
      total_tokens: number;
    };
  } | null;
}

/**
 * Extract token usage from a Codex rollout transcript (JSONL lines).
 *
 * Real Codex data nests token_count inside {"type":"event_msg","payload":{...}}.
 * The info.total_token_usage object may be null; guard against it.
 *
 * Measured across 654 real rollouts: LAST and MAX agree on total_tokens in
 * every file (0 disagreements). The one non-monotonic file still had LAST==MAX.
 * LAST is correct — Codex is cumulative within a session.
 */
export function extractCodexRolloutTokens(lines: string[]): TokenUsage | undefined {
  let last: TokenCountPayload | undefined;

  for (const raw of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (!isEventMsgWithTokenCount(parsed)) continue;
    last = parsed.payload;
  }

  if (!last) return undefined;

  const tu = last.info?.total_token_usage;
  if (!tu) return undefined;

  const inputTokens = num(tu.input_tokens) + num(tu.cached_input_tokens) + num(tu.cache_write_input_tokens);
  const outputTokens = num(tu.output_tokens); // reasoning_output_tokens already in output_tokens

  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

function isEventMsgWithTokenCount(v: unknown): v is { type: 'event_msg'; payload: TokenCountPayload } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { type?: unknown }).type === 'event_msg' &&
    typeof (v as { payload?: unknown }).payload === 'object' &&
    (v as { payload?: { type?: unknown } }).payload?.type === 'token_count'
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
  const lines = await readTranscriptLines(options);
  if (!lines) return undefined;
  return options.provider === 'claude-code' ? extractClaudeTranscriptTokens(lines) : extractCodexRolloutTokens(lines);
}

export async function readAgentTools(options: ReadTelemetryOptions): Promise<AgentToolCallSummary[] | undefined> {
  const lines = await readTranscriptLines(options);
  if (!lines) return undefined;
  return options.provider === 'claude-code' ? extractClaudeToolEvents(lines) : extractCodexToolEvents(lines);
}

async function readTranscriptLines(options: ReadTelemetryOptions): Promise<string[] | undefined> {
  const { transcriptPath, sandboxKind } = options;

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

  return content.split('\n').filter(l => l.trim());
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
