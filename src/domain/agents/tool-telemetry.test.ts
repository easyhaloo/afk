import { describe, expect, it } from 'vitest';
import { extractClaudeToolEvents, extractCodexToolEvents } from './tool-telemetry.js';

describe('extractClaudeToolEvents', () => {
  it('deduplicates native tool ids and keeps only metadata from results', () => {
    const use = JSON.stringify({
      type: 'assistant', timestamp: '2026-10-13T00:00:00Z',
      message: { id: 'message-1', content: [
        { type: 'tool_use', id: 'call-1', name: 'Bash', input: { command: 'private command' } },
        { type: 'tool_use', id: 'call-2', name: 'Read', input: { path: 'private path' } },
      ] },
    });
    const result = JSON.stringify({
      type: 'user', timestamp: '2026-10-13T00:00:01Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true, content: 'private output' }] },
    });
    expect(extractClaudeToolEvents([use, use, result, result, use])).toEqual([
      { id: 'call-1', name: 'Bash', result: 'failed', startedAt: '2026-10-13T00:00:00Z', completedAt: '2026-10-13T00:00:01Z' },
      { id: 'call-2', name: 'Read', result: 'unknown', startedAt: '2026-10-13T00:00:00Z' },
    ]);
  });

  it('uses native is_error defaults, ignores malformed lines, and leaves missing results unknown', () => {
    const lines = ['{bad', 'null', '[]', '{}', JSON.stringify({ type: 'assistant', message: { content: [
      null, { type: 'tool_use', id: 1, name: 'Read' },
      { type: 'tool_use', id: 'ok', name: 'Read' }, { type: 'tool_use', id: 'missing', name: 'Bash' },
      { type: 'tool_use', id: 'bad-result', name: 'Edit' },
    ] } }), JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'ok', content: 'error exit code 99' },
      { type: 'tool_result', tool_use_id: 'bad-result', is_error: 'false', content: 'success' },
      { type: 'tool_result', tool_use_id: 'orphan', is_error: false },
    ] } }), '{"type":"user"'];
    expect(extractClaudeToolEvents(lines)).toEqual([
      { id: 'ok', name: 'Read', result: 'succeeded' },
      { id: 'missing', name: 'Bash', result: 'unknown' },
      { id: 'bad-result', name: 'Edit', result: 'unknown' },
    ]);
    expect(extractClaudeToolEvents(['null', '{bad'])).toBeUndefined();
  });
});

describe('extractCodexToolEvents', () => {
  it('includes other native tool items without reading paths, queries or result text', () => {
    expect(extractCodexToolEvents([
      JSON.stringify({ type: 'item.completed', item: { id: 'patch', type: 'file_change', status: 'failed', changes: [{ path: 'private path' }] } }),
      JSON.stringify({ method: 'item/completed', params: { item: { id: 'search', type: 'webSearch', query: 'private query' } } }),
      JSON.stringify({ method: 'item/completed', params: { item: { id: 'dynamic', type: 'dynamicToolCall', tool: 'lookup', status: 'completed', success: false, contentItems: [{ text: 'success' }] } } }),
      JSON.stringify({ method: 'item/completed', params: { item: { id: 'collab', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', prompt: 'private prompt' } } }),
    ])).toEqual([
      { id: 'patch', name: 'file_change', result: 'failed' },
      { id: 'search', name: 'web_search', result: 'unknown' },
      { id: 'dynamic', name: 'lookup', result: 'failed' },
      { id: 'collab', name: 'spawnAgent', result: 'succeeded' },
    ]);
  });

  it('keeps incomplete and unconfirmed commands distinct and skips malformed or non-tool events', () => {
    const line = (phase: string, item: object) => JSON.stringify({ type: `item.${phase}`, item });
    expect(extractCodexToolEvents([
      '{bad', 'null', '[]', '{}', line('started', { id: 'pending', type: 'command_execution' }),
      line('completed', { id: 'unknown', type: 'command_execution', status: 'completed', exit_code: null, aggregated_output: 'success exit code 0' }),
      line('completed', { id: 'ok', type: 'command_execution', exit_code: 0, aggregated_output: 'error exit code 1' }),
      line('completed', { id: 'failed', type: 'command_execution', status: 'failed' }),
      line('completed', { id: 'mcp', type: 'mcp_tool_call', server: 'docs', tool: 'lookup', status: 'completed' }),
      line('completed', { id: 'bad-code', type: 'command_execution', exit_code: '0', duration_ms: -1, status: 'completed' }),
      line('completed', { id: 'mcp-unknown', type: 'mcp_tool_call', server: 'docs', tool: 'lookup', result: { content: 'success' } }),
      line('completed', { id: 'message', type: 'agent_message', text: 'success' }),
      line('completed', { type: 'command_execution', exit_code: 0 }),
      JSON.stringify({ type: 'item.completed', item: null }), '{"type":"item.completed"',
    ])).toEqual([
      { id: 'pending', name: 'command_execution', result: 'in_progress' },
      { id: 'unknown', name: 'command_execution', result: 'unknown' },
      { id: 'ok', name: 'command_execution', result: 'succeeded', exitCode: 0 },
      { id: 'failed', name: 'command_execution', result: 'failed' },
      { id: 'mcp', name: 'docs.lookup', result: 'succeeded' },
      { id: 'bad-code', name: 'command_execution', result: 'unknown' },
      { id: 'mcp-unknown', name: 'docs.lookup', result: 'unknown' },
    ]);
    expect(extractCodexToolEvents([JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'call-1', name: 'exec_command', arguments: 'private' } })])).toBeUndefined();
    expect(extractCodexToolEvents([])).toBeUndefined();
  });

  it.each(['exec', 'app-server'])('merges %s lifecycle metadata and trusts the command exit code', transport => {
    const appServer = transport === 'app-server';
    const commandType = appServer ? 'commandExecution' : 'command_execution';
    const mcpType = appServer ? 'mcpToolCall' : 'mcp_tool_call';
    const line = (phase: string, item: object) => JSON.stringify(appServer
      ? { method: `item/${phase}`, params: { item, ...(phase === 'started' ? { startedAtMs: 1791849600000 } : { completedAtMs: 1791849601000 }) } }
      : { type: `item.${phase}`, item, timestamp: phase === 'started' ? '2026-10-13T00:00:00.000Z' : '2026-10-13T00:00:01.000Z' });
    const started = line('started', { id: 'cmd-1', type: commandType, status: appServer ? 'inProgress' : 'in_progress', command: 'private command' });
    const completed = line('completed', {
      id: 'cmd-1', type: commandType, status: 'completed',
      [appServer ? 'exitCode' : 'exit_code']: 7,
      [appServer ? 'durationMs' : 'duration_ms']: 250,
      [appServer ? 'aggregatedOutput' : 'aggregated_output']: 'success private output',
    });
    expect(extractCodexToolEvents([
      started, started, completed, completed, started,
      line('completed', { id: 'mcp-1', type: mcpType, server: 'docs', tool: 'lookup', status: 'failed', error: { message: 'private error' }, arguments: { token: 'private token' } }),
    ])).toEqual([
      { id: 'cmd-1', name: 'command_execution', result: 'failed', exitCode: 7, durationMs: 250, startedAt: '2026-10-13T00:00:00.000Z', completedAt: '2026-10-13T00:00:01.000Z' },
      { id: 'mcp-1', name: 'docs.lookup', result: 'failed', completedAt: '2026-10-13T00:00:01.000Z' },
    ]);
  });
});
