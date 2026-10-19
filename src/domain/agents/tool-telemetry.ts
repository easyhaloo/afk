import type { AgentToolCallSummary } from '@afk/core';

type ToolProvider = 'claude-code' | 'codex' | 'opencode';

interface RawToolEvent {
  type?: unknown;
  method?: unknown;
  params?: unknown;
  item?: unknown;
  message?: unknown;
  timestamp?: unknown;
  startedAtMs?: unknown;
  completedAtMs?: unknown;
}

interface RawToolItem {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  tool_use_id?: unknown;
  is_error?: unknown;
  server?: unknown;
  tool?: unknown;
  status?: unknown;
  success?: unknown;
  exit_code?: unknown;
  exitCode?: unknown;
  duration_ms?: unknown;
  durationMs?: unknown;
}

interface RawClaudeMessage {
  content?: unknown;
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function timestamp(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function collectAgentToolEvent(
  provider: ToolProvider,
  event: unknown,
  tools: Map<string, AgentToolCallSummary>,
): void {
  const entry: RawToolEvent = isObject(event) ? event : {};
  if (provider === 'codex') {
    collectCodexToolEvent(entry, tools);
    return;
  }
  if (entry.type !== 'assistant' && entry.type !== 'user') return;
  const content = isObject(entry.message) ? (entry.message as RawClaudeMessage).content : undefined;
  if (!Array.isArray(content)) return;
  for (const value of content) {
    const block: RawToolItem = isObject(value) ? value : {};
    if (entry.type === 'assistant' && block.type === 'tool_use') {
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) continue;
      if (tools.has(block.id)) continue;
      const startedAt = timestamp(entry.timestamp);
      tools.set(block.id, { id: block.id, name: block.name, result: 'unknown', ...(startedAt ? { startedAt } : {}) });
    } else if (entry.type === 'user' && block.type === 'tool_result') {
      if (typeof block.tool_use_id !== 'string') continue;
      const tool = tools.get(block.tool_use_id);
      if (!tool) continue;
      const completedAt = timestamp(entry.timestamp);
      tools.set(tool.id, {
        ...tool,
        result: block.is_error === true ? 'failed'
          : block.is_error === false || block.is_error === undefined ? 'succeeded' : 'unknown',
        ...(completedAt ? { completedAt } : {}),
      });
    }
  }
}

function collectCodexToolEvent(entry: RawToolEvent, tools: Map<string, AgentToolCallSummary>): void {
  const method = entry.method ?? entry.type;
  if (method !== 'item.started' && method !== 'item.completed' && method !== 'item/started' && method !== 'item/completed') return;
  const params: RawToolEvent = entry.method ? isObject(entry.params) ? entry.params : {} : entry;
  const item: RawToolItem = isObject(params.item) ? params.item : {};
  if (typeof item.id !== 'string' || !item.id) return;
  let name: string;
  switch (item.type) {
    case 'command_execution':
    case 'commandExecution':
      name = 'command_execution';
      break;
    case 'mcp_tool_call':
    case 'mcpToolCall':
      if (typeof item.server !== 'string' || !item.server || typeof item.tool !== 'string' || !item.tool) return;
      name = `${item.server}.${item.tool}`;
      break;
    case 'file_change':
    case 'fileChange':
      name = 'file_change';
      break;
    case 'web_search':
    case 'webSearch':
      name = 'web_search';
      break;
    case 'dynamicToolCall':
    case 'collabAgentToolCall':
      if (typeof item.tool !== 'string' || !item.tool) return;
      name = item.tool;
      break;
    default:
      return;
  }
  const completed = method === 'item.completed' || method === 'item/completed';
  const previous = tools.get(item.id);
  if (!completed && previous) return;
  const rawExitCode = item.exit_code ?? item.exitCode;
  const exitCode = typeof rawExitCode === 'number' && Number.isSafeInteger(rawExitCode) ? rawExitCode : undefined;
  const command = item.type === 'command_execution' || item.type === 'commandExecution';
  const dynamic = item.type === 'dynamicToolCall';
  const result: AgentToolCallSummary['result'] = item.status === 'failed' || item.status === 'declined' || (exitCode !== undefined && exitCode !== 0) || (dynamic && item.success === false)
    ? 'failed'
    : !completed || item.status === 'in_progress' || item.status === 'inProgress' ? 'in_progress'
      : command ? exitCode === 0 ? 'succeeded' : 'unknown'
        : dynamic ? item.success === true ? 'succeeded' : 'unknown'
        : item.status === 'completed' ? 'succeeded' : 'unknown';
  const nativeMs = completed ? params.completedAtMs : params.startedAtMs;
  const date = typeof nativeMs === 'number' ? new Date(nativeMs) : undefined;
  const time = date && Number.isFinite(date.getTime()) ? date.toISOString() : timestamp(entry.timestamp);
  const durationMs = item.duration_ms ?? item.durationMs;
  tools.set(item.id, {
    ...previous,
    id: item.id,
    name,
    result,
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(time ? completed ? { completedAt: time } : { startedAt: time } : {}),
    ...(typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? { durationMs } : {}),
  });
}

function extractToolEvents(provider: ToolProvider, lines: readonly string[]): AgentToolCallSummary[] | undefined {
  const tools = new Map<string, AgentToolCallSummary>();
  for (const line of lines) {
    try {
      collectAgentToolEvent(provider, JSON.parse(line), tools);
    } catch {
      continue;
    }
  }
  return tools.size ? [...tools.values()] : undefined;
}

export function extractClaudeToolEvents(lines: readonly string[]): AgentToolCallSummary[] | undefined {
  return extractToolEvents('claude-code', lines);
}

export function extractCodexToolEvents(lines: readonly string[]): AgentToolCallSummary[] | undefined {
  return extractToolEvents('codex', lines);
}

export function extractOpenCodeToolEvents(lines: readonly string[]): AgentToolCallSummary[] | undefined {
  const tools: AgentToolCallSummary[] = [];
  for (const line of lines) {
    try {
      const exportData = JSON.parse(line) as { messages?: Array<{ parts?: unknown[] }> };
      for (const message of exportData.messages ?? []) {
        for (const rawPart of message.parts ?? []) {
          if (!isObject(rawPart)) continue;
          const part = rawPart as { type?: unknown; callID?: unknown; tool?: unknown; state?: unknown };
          if (part.type !== 'tool' || typeof part.callID !== 'string' || typeof part.tool !== 'string') continue;
          const state = isObject(part.state) ? part.state as { status?: unknown } : {};
          const status = state.status;
          const result: AgentToolCallSummary['result'] = status === 'error' || status === 'rejected'
            ? 'failed'
            : status === 'completed'
              ? 'succeeded'
              : 'in_progress';
          tools.push({ id: part.callID, name: part.tool, result });
        }
      }
    } catch {
      continue;
    }
  }
  return tools.length ? tools : undefined;
}
