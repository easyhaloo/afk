/**
 * Agent telemetry collection and transcript readers.
 *
 * Boundary: harness owns agent-layer truth. AFK only READS.
 */

import type { AgentToolCallSummary } from '@afk/core';
import type { AgentExecution, ExecutionResult, TokenUsage } from '../../domain/agents/types.js';
import { extractClaudeToolEvents, extractCodexToolEvents, extractOpenCodeToolEvents } from '../../domain/agents/tool-telemetry.js';
export { extractClaudeToolEvents, extractCodexToolEvents, extractOpenCodeToolEvents } from '../../domain/agents/tool-telemetry.js';

export interface ResolvedAgentTranscript {
  path: string;
  sessionId: string;
}

export function extractClaudeSessionId(lines: readonly string[]): string | undefined {
  for (const raw of lines) {
    try {
      const parsed = JSON.parse(raw) as { session_id?: unknown; sessionId?: unknown };
      const sessionId = typeof parsed.session_id === 'string' && parsed.session_id.length > 0
        ? parsed.session_id
        : typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0
          ? parsed.sessionId
          : undefined;
      if (sessionId) return sessionId;
    } catch {
      // Ignore incomplete transcript lines.
    }
  }
  return undefined;
}

export async function resolveAgentTranscript(options: {
  provider: 'claude-code' | 'codex' | 'opencode';
  telemetryPath?: string;
  threadId?: string;
}): Promise<ResolvedAgentTranscript | undefined> {
  const { dirname, extname, basename, join } = await import('node:path');
  const { readFile, stat } = await import('node:fs/promises');
  if (options.provider === 'opencode') {
    if (!options.threadId) return undefined;
    const { homedir } = await import('node:os');
    const dataRoot = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
    const messagePath = join(dataRoot, 'opencode', 'storage', 'message', options.threadId);
    try {
      if ((await stat(messagePath)).isDirectory()) return { path: messagePath, sessionId: options.threadId };
    } catch {
      // Fall back to the provider export endpoint for database-only sessions.
    }
    return { path: `opencode://session/${encodeURIComponent(options.threadId)}`, sessionId: options.threadId };
  }
  const sourcePaths = options.provider === 'codex'
    ? [options.threadId ? await findCodexRollout(options.threadId) : undefined]
    : [options.telemetryPath, options.telemetryPath && options.threadId
      ? join(dirname(options.telemetryPath), `${options.threadId}.jsonl`)
      : undefined];

  for (const sourcePath of sourcePaths) {
    if (!sourcePath) continue;
    let lines: string[];
    try {
      lines = (await readFile(sourcePath, 'utf8')).split('\n').filter(line => line.trim());
    } catch {
      continue;
    }
    const sessionId = options.provider === 'claude-code'
      ? extractClaudeSessionId(lines)
      : options.threadId;
    if (options.threadId && sessionId && sessionId !== options.threadId) continue;
    return { path: sourcePath, sessionId: sessionId ?? options.threadId ?? basename(sourcePath, extname(sourcePath)) };
  }
  return undefined;
}

export async function resolveAgentTranscriptPath(options: {
  provider: 'claude-code' | 'codex' | 'opencode';
  telemetryPath?: string;
  threadId?: string;
}): Promise<string | undefined> {
  return (await resolveAgentTranscript(options))?.path;
}

export async function collectAgentTelemetry(
  execution: AgentExecution,
  result: ExecutionResult,
  sandboxKind: 'local' | 'container',
): Promise<{ sessionId: string; transcriptPath?: string; usage?: TokenUsage; tools?: AgentToolCallSummary[] }> {
  const provider = execution.metadata.provider;
  const transcript = sandboxKind === 'local' && (provider === 'claude-code' || provider === 'codex' || provider === 'opencode')
    ? await resolveAgentTranscript({
      provider,
      telemetryPath: execution.telemetryPath,
      threadId: execution.metadata.threadId,
    })
    : undefined;
  let usage = result.usage;
  let tools = result.tools;
  if (transcript && (provider === 'claude-code' || provider === 'codex' || provider === 'opencode')) {
    const options = { provider, transcriptPath: transcript.path, sandboxKind };
    if (!usage) usage = await readAgentTelemetry(options);
    if (!tools) tools = await readAgentTools(options);
  }
  return {
    sessionId: transcript?.sessionId ?? execution.metadata.threadId ?? result.sessionId ?? execution.id,
    ...(transcript ? { transcriptPath: transcript.path } : {}),
    usage,
    tools,
  };
}

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

export function extractOpenCodeTranscriptTokens(lines: string[]): TokenUsage | undefined {
  for (const raw of lines) {
    try {
      const parsed = JSON.parse(raw) as {
        info?: { tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } };
        messages?: Array<{ info?: { role?: unknown; tokens?: { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown; write?: unknown } } } }>;
      };
      const tokenSets = parsed.info?.tokens
        ? [parsed.info.tokens]
        : (parsed.messages ?? []).filter(message => message.info?.role === 'assistant').map(message => message.info?.tokens).filter(tokens => tokens !== undefined);
      if (!tokenSets.length) continue;
      const inputTokens = tokenSets.reduce((sum, tokens) => sum + num(tokens.input) + num(tokens.cache?.read) + num(tokens.cache?.write), 0);
      const outputTokens = tokenSets.reduce((sum, tokens) => sum + num(tokens.output) + num(tokens.reasoning), 0);
      return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
    } catch {
      continue;
    }
  }
  return undefined;
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
  provider: 'claude-code' | 'codex' | 'opencode';
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
  if (options.provider === 'claude-code') return extractClaudeTranscriptTokens(lines);
  if (options.provider === 'codex') return extractCodexRolloutTokens(lines);
  return extractOpenCodeTranscriptTokens(lines);
}

export async function readAgentTranscript(options: ReadTelemetryOptions): Promise<string | undefined> {
  const lines = await readTranscriptLines(options);
  return lines?.join('\n');
}

export async function readAgentTools(options: ReadTelemetryOptions): Promise<AgentToolCallSummary[] | undefined> {
  const lines = await readTranscriptLines(options);
  if (!lines) return undefined;
  if (options.provider === 'claude-code') return extractClaudeToolEvents(lines);
  if (options.provider === 'codex') return extractCodexToolEvents(lines);
  return extractOpenCodeToolEvents(lines);
}

async function readTranscriptLines(options: ReadTelemetryOptions): Promise<string[] | undefined> {
  const { transcriptPath, sandboxKind } = options;
  const { dirname, join, basename } = await import('node:path');

  if (sandboxKind === 'container') {
    // HOME is excluded from container env; harness dirs are not mounted.
    return undefined;
  }

  let content: string;
  try {
    const { readdir, readFile, stat } = await import('node:fs/promises');
    if (transcriptPath.startsWith('opencode://session/')) {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const sessionId = decodeURIComponent(transcriptPath.slice('opencode://session/'.length));
      const query = async <T>(sql: string): Promise<T[]> => {
        const result = await promisify(execFile)('opencode', ['db', sql, '--pure', '--format', 'json'], { maxBuffer: 16 * 1024 * 1024 });
        return JSON.parse(result.stdout) as T[];
      };
      const escaped = sessionId.replaceAll("'", "''");
      const pageSize = 50;
      const sessionRows = await query<{ tokens_input: number; tokens_output: number; tokens_reasoning: number; tokens_cache_read: number; tokens_cache_write: number }>(`select tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write from session where id='${escaped}'`);
      const sessionTokens = sessionRows[0];
      const messages: Array<{ id: string; role?: string; tokens?: string | null }> = [];
      const parts: Array<{ message_id: string; call_id?: string; tool?: string; status?: string }> = [];
      for (let offset = 0; ; offset += pageSize) {
        const page = await query<{ id: string; role?: string; tokens?: string | null }>(`select id, json_extract(data, '$.role') as role, json_extract(data, '$.tokens') as tokens from message where session_id='${escaped}' order by time_created limit ${pageSize} offset ${offset}`);
        messages.push(...page);
        if (page.length < pageSize) break;
      }
      for (let offset = 0; ; offset += pageSize) {
        const page = await query<{ message_id: string; call_id?: string; tool?: string; status?: string }>(`select message_id, json_extract(data, '$.callID') as call_id, json_extract(data, '$.tool') as tool, json_extract(data, '$.state.status') as status from part where session_id='${escaped}' and json_extract(data, '$.type')='tool' order by time_created limit ${pageSize} offset ${offset}`);
        parts.push(...page);
        if (page.length < pageSize) break;
      }
      const partsByMessage = new Map<string, unknown[]>();
      for (const part of parts) partsByMessage.set(part.message_id, [...(partsByMessage.get(part.message_id) ?? []), { type: 'tool', callID: part.call_id, tool: part.tool, state: { status: part.status } }]);
      return [JSON.stringify({
        info: sessionTokens ? { tokens: { input: sessionTokens.tokens_input, output: sessionTokens.tokens_output, reasoning: sessionTokens.tokens_reasoning, cache: { read: sessionTokens.tokens_cache_read, write: sessionTokens.tokens_cache_write } } } : undefined,
        messages: messages.map(message => ({ info: { id: message.id, sessionID: sessionId, role: message.role }, parts: partsByMessage.get(message.id) ?? [] })),
      })];
    }
    if (options.provider === 'opencode' && (await stat(transcriptPath)).isDirectory()) {
      const messageFiles = (await readdir(transcriptPath)).filter(name => name.endsWith('.json'));
      const storageRoot = dirname(dirname(transcriptPath));
      const messages = await Promise.all(messageFiles.map(async file => {
        const message = JSON.parse(await readFile(join(transcriptPath, file), 'utf8')) as { id?: string };
        const partPath = join(storageRoot, 'part', message.id ?? basename(file, '.json'));
        const parts = await readdir(partPath).catch(() => []);
        return { info: message, parts: await Promise.all(parts.filter(part => part.endsWith('.json')).map(part => readFile(join(partPath, part), 'utf8').then(JSON.parse))) };
      }));
      return [JSON.stringify({ messages })];
    }
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
