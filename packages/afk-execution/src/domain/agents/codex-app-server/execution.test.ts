import { describe, expect, it, vi } from 'vitest';
import { CodexAppServerExecution } from './execution.js';
import type { AgentExecutionOptions, CodexRuntimeSelection } from '../types.js';
import type { AppServerTransport, JsonRpcMessage } from './transport.js';

class ScriptedTransport implements AppServerTransport {
  readonly endpointKind = 'stdio' as const;
  readonly sent: JsonRpcMessage[] = [];
  closeCalls = 0;
  closeError?: Error;
  initializeError?: Error;
  private readonly queue: JsonRpcMessage[] = [];
  private readonly readers: Array<(value: IteratorResult<JsonRpcMessage>) => void> = [];
  private ended = false;

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if (message.method === 'initialize' && this.initializeError) throw this.initializeError;
    if (!('id' in message) || message.id === undefined) return;
    if (message.method === 'initialize') this.push({ jsonrpc: '2.0', id: message.id, result: {} });
    if (message.method === 'thread/start') this.push({ jsonrpc: '2.0', id: message.id, result: { thread: { id: 'thread-1' } } });
    if (message.method === 'turn/start') this.push({ jsonrpc: '2.0', id: message.id, result: { turn: { id: 'turn-1' } } });
    if (message.method === 'turn/interrupt') this.push({ jsonrpc: '2.0', id: message.id, result: {} });
  }

  push(message: JsonRpcMessage): void {
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value: message });
    else this.queue.push(message);
  }

  messages(): AsyncIterable<JsonRpcMessage> {
    return { [Symbol.asyncIterator]: () => ({ next: () => this.next() }) };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeError) throw this.closeError;
    this.ended = true;
    for (const reader of this.readers.splice(0)) reader({ done: true, value: undefined });
  }

  private next(): Promise<IteratorResult<JsonRpcMessage>> {
    const message = this.queue.shift();
    if (message) return Promise.resolve({ done: false, value: message });
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise(resolve => this.readers.push(resolve));
  }
}

const runtime: CodexRuntimeSelection = {
  kind: 'codex', transport: 'app-server', auth: 'chatgpt', provider: 'openai',
  endpoint: 'stdio://', startupTimeoutMs: 5_000,
};

const options = (): AgentExecutionOptions => ({
  sandbox: { id: 'local', worktreePath: '/tmp/worktree', workspacePath: '/tmp/worktree' } as never,
  worktreePath: '/tmp/worktree', sessionId: 'session-1', prompt: 'implement the backlog',
  signalType: 'goal_complete', generation: 1, executionMode: 'batch', runtime,
});

describe('CodexAppServerExecution', () => {
  it('collects native command and MCP notifications without retaining their bodies', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    const started: JsonRpcMessage = {
      jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1791849600000,
        item: { id: 'cmd-1', type: 'commandExecution', command: 'private command', status: 'inProgress', exitCode: null },
      },
    };
    const completed: JsonRpcMessage = {
      jsonrpc: '2.0', method: 'item/completed', params: {
        threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1791849601000,
        item: { id: 'cmd-1', type: 'commandExecution', status: 'completed', exitCode: 9, durationMs: 25, aggregatedOutput: 'private success' },
      },
    };
    transport.push(started);
    transport.push(started);
    transport.push(completed);
    transport.push(completed);
    transport.push(started);
    transport.push({ jsonrpc: '2.0', method: 'item/completed', params: { item: null } });
    transport.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        item: { id: 'mcp-1', type: 'mcpToolCall', server: 'docs', tool: 'lookup', status: 'failed', durationMs: 3, arguments: { token: 'private token' }, error: { message: 'private error' }, result: null },
      },
    });
    transport.push({
      jsonrpc: '2.0', method: 'item/completed', params: {
        item: { id: 'message-1', type: 'agentMessage', text: '<goal_complete>{"type":"goal_complete"}</goal_complete>' },
      },
    });
    transport.push({ jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
    const result = await execution.waitForResult();
    expect(result.status).toBe('completed');
    expect(result.tools).toEqual([
      { id: 'cmd-1', name: 'command_execution', result: 'failed', exitCode: 9, durationMs: 25, startedAt: '2026-10-13T00:00:00.000Z', completedAt: '2026-10-13T00:00:01.000Z' },
      { id: 'mcp-1', name: 'docs.lookup', result: 'failed', durationMs: 3 },
    ]);
    expect(JSON.stringify(result.tools)).not.toContain('private');
    expect(await execution.captureOutput()).not.toContain('private');
  });

  it.each(['failed', 'missing_result', 'aborted', 'timed_out'])('returns incomplete tool metadata when %s', async status => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    transport.push({ jsonrpc: '2.0', method: 'item/started', params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'private', status: 'inProgress' } } });
    transport.push({ jsonrpc: '2.0', method: 'thread/tokenUsage/updated', params: { tokenUsage: { total: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } } });
    await expect(execution.waitForEvent()).resolves.toMatchObject({ type: 'usage' });
    if (status === 'aborted') await execution.interrupt('manual');
    else if (status !== 'timed_out') transport.push({
      jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: status === 'failed' ? 'failed' : 'completed' } },
    });
    const result = await execution.waitForResult({ completionTimeoutMs: status === 'timed_out' ? 1 : 1000 });
    expect(result.status).toBe(status === 'missing_result' ? 'failed' : status);
    expect(result.tools).toEqual([{ id: 'cmd-1', name: 'command_execution', result: 'in_progress' }]);
  });

  it('performs the app-server lifecycle and normalizes completion diagnostics', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);

    expect(transport.sent.map(message => 'method' in message ? message.method : undefined)).toEqual([
      'initialize', 'initialized', 'thread/start', 'turn/start',
    ]);
    expect(transport.sent[2]).toMatchObject({
      params: { cwd: '/tmp/worktree', approvalPolicy: 'never', sandbox: 'danger-full-access', modelProvider: 'openai' },
    });
    expect(transport.sent[3]).toMatchObject({
      params: {
        threadId: 'thread-1',
        input: [{ type: 'text', text: 'implement the backlog', text_elements: [] }],
      },
    });

    transport.push({
      jsonrpc: '2.0', method: 'item/completed',
      params: { item: { type: 'agentMessage', text: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>' } },
    });
    transport.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
          last: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      },
    });
    transport.push({
      jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    await expect(execution.waitForResult({ completionTimeoutMs: 1_000 })).resolves.toMatchObject({
      status: 'completed',
      provider: 'codex',
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'done' },
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(execution.metadata).toEqual({
      provider: 'codex', transport: 'app-server', auth: 'chatgpt', modelProvider: 'openai',
      endpointKind: 'stdio', threadId: 'thread-1',
    });
    expect(await execution.captureOutput()).toContain('<goal_complete>');
    expect(transport.closeCalls).toBe(1);
  });

  it('recognizes a completion marker split across app-server message items', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    transport.push({
      jsonrpc: '2.0', method: 'item/completed',
      params: { item: { type: 'agentMessage', text: '<goal_complete>{"type":"goal_complete","kind":"task","summ' } },
    });
    transport.push({
      jsonrpc: '2.0', method: 'item/completed',
      params: { item: { type: 'agentMessage', text: 'ary":"split"}</goal_complete>' } },
    });
    transport.push({
      jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    await expect(execution.waitForResult()).resolves.toMatchObject({
      status: 'completed', structuredOutput: { type: 'goal_complete', summary: 'split' },
    });
  });

  it('interrupts the active turn and reports an aborted result', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    await execution.interrupt('manual');

    expect(transport.sent.at(-1)).toMatchObject({
      method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    await expect(execution.waitForResult()).resolves.toMatchObject({ status: 'aborted' });
  });

  it('lets the app-server resolve its own model provider when selection is auto', async () => {
    const transport = new ScriptedTransport();
    const automatic = { ...runtime, provider: 'auto' };
    const execution = await CodexAppServerExecution.start(
      { ...options(), runtime: automatic },
      automatic,
      () => transport,
    );

    expect(transport.sent[2]).toMatchObject({ method: 'thread/start' });
    expect(transport.sent[2].params).not.toHaveProperty('modelProvider');
    await execution.kill();
  });

  it('preserves timeout semantics while closing the transport', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);

    await expect(execution.waitForResult({ completionTimeoutMs: 5 })).resolves.toMatchObject({
      status: 'timed_out',
    });
    expect(transport.closeCalls).toBe(1);
  });

  it('closes the transport when completion has no structured result', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    transport.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    await expect(execution.waitForResult()).resolves.toMatchObject({
      status: 'failed', error: { code: 'MISSING_RESULT' },
    });
    expect(transport.closeCalls).toBe(1);
  });

  it('closes the transport when the app-server reports an agent error', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    transport.push({
      jsonrpc: '2.0', method: 'error', params: { willRetry: false, message: 'model failed' },
    });

    await expect(execution.waitForResult()).resolves.toMatchObject({
      status: 'failed', error: { code: 'AGENT_ERROR', message: 'model failed' },
    });
    expect(transport.closeCalls).toBe(1);
  });

  it('reports and closes a transport that ends before completion', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    await transport.close();

    await expect(execution.waitForResult()).resolves.toMatchObject({
      status: 'failed', error: { code: 'TRANSPORT_CLOSED' },
    });
    expect(transport.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('captures terminal cleanup failures without rejecting in the background', async () => {
    const transport = new ScriptedTransport();
    transport.closeError = new Error('close leaked secret detail');
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    transport.push({
      jsonrpc: '2.0', method: 'item/completed',
      params: { item: { type: 'agentMessage', text: '<goal_complete>{"type":"goal_complete","kind":"task","summary":"done"}</goal_complete>' } },
    });
    transport.push({
      jsonrpc: '2.0', method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    const result = await execution.waitForResult();

    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'TRANSPORT_CLOSE_FAILED', message: 'Codex app-server cleanup failed' },
    });
    expect(JSON.stringify(result)).not.toContain('secret detail');
  });

  it('rejects spawned stdio app-server inside a container sandbox', async () => {
    const createTransport = vi.fn();
    await expect(CodexAppServerExecution.start({
      ...options(),
      sandbox: { id: 'container', worktreePath: '/host/worktree', workspacePath: '/workspace' } as never,
    }, runtime, createTransport)).rejects.toThrow(/container/i);
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('redacts startup and cleanup failures', async () => {
    const transport = new ScriptedTransport();
    transport.initializeError = new Error('initialize leaked sk-startup');
    transport.closeError = new Error('close leaked sk-cleanup');

    const error = await CodexAppServerExecution.start(options(), runtime, () => transport)
      .then(() => undefined, reason => reason as Error);

    expect(error?.message).toBe('Codex app-server startup failed');
    expect(error?.message).not.toContain('sk-startup');
    expect(error?.message).not.toContain('sk-cleanup');
  });
});
