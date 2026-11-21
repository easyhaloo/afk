import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { CodexAppServerExecution } from './execution.js';
import { NativeResumeDispatchError } from '../types.js';
import type { AgentExecutionOptions, CodexRuntimeSelection } from '../types.js';
import type { AppServerTransport, JsonRpcMessage } from './transport.js';

class ScriptedTransport implements AppServerTransport {
  readonly endpointKind = 'stdio' as const;
  readonly sent: JsonRpcMessage[] = [];
  closeCalls = 0;
  closeError?: Error;
  initializeError?: Error;
  results = new Map<string, unknown>();
  private readonly queue: JsonRpcMessage[] = [];
  private readonly readers: Array<(value: IteratorResult<JsonRpcMessage>) => void> = [];
  private ended = false;

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if (message.method === 'initialize' && this.initializeError) throw this.initializeError;
    if (!('id' in message) || message.id === undefined) return;
    if (this.results.has(message.method!)) {
      this.push({ id: message.id, result: this.results.get(message.method!) });
      return;
    }
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
  function nativeFixture() {
    const workspace = realpathSync(process.cwd());
    const sessionId = randomUUID();
    const previousTurn = randomUUID();
    const turnId = randomUUID();
    const transport = new ScriptedTransport();
    const thread = { id: sessionId, cwd: workspace, status: { type: 'notLoaded' } };
    const resumed = { thread, cwd: workspace, modelProvider: 'openai', sandbox: { type: 'dangerFullAccess' }, approvalPolicy: 'never' };
    transport.results.set('thread/read', { thread });
    transport.results.set('thread/resume', resumed);
    transport.results.set('thread/turns/list', { data: [{ id: previousTurn, status: 'completed' }] });
    transport.results.set('turn/start', { turn: { id: turnId } });
    const total = { inputTokens: 10, outputTokens: 2, totalTokens: 12 };
    const opts = { ...options(), worktreePath: workspace,
      sandbox: { ...options().sandbox, localProcessWorkspace: true, worktreePath: workspace, workspacePath: workspace },
      resume: { sessionId, generation: 0, summary: '', capturedAt: '', checkpoint: { version: 1, provider: 'codex',
        sessionId, worktreePath: workspace, turnId: previousTurn, transport: 'stdio', total, modelProvider: 'openai' } } };
    return { opts, sessionId, turnId, previousTurn, resumed, thread, transport, start: () => CodexAppServerExecution.start(opts, runtime, () => transport) };
  }

  it.each(['requested workspace', 'native workspace', 'thread id', 'active', 'resumed id', 'resumed workspace', 'approval', 'sandbox', 'model provider', 'stale turn', 'generation'])('rejects %s mismatch before dispatch', async failure => {
    const fixture = nativeFixture();
    const { opts, thread, resumed, transport } = fixture;
    switch (failure) {
      case 'requested workspace': opts.sandbox.workspacePath = '/'; break;
      case 'native workspace': thread.cwd = '/'; break;
      case 'thread id': thread.id = randomUUID(); break;
      case 'active': thread.status.type = 'active'; break;
      case 'resumed id': resumed.thread = { ...thread, id: randomUUID() }; break;
      case 'resumed workspace': resumed.cwd = '/'; break;
      case 'approval': resumed.approvalPolicy = 'on-request'; break;
      case 'sandbox': resumed.sandbox.type = 'readOnly'; break;
      case 'model provider': resumed.modelProvider = 'other'; break;
      case 'stale turn': opts.resume.checkpoint.turnId = randomUUID(); break;
      case 'generation': opts.generation++; break;
    }
    await expect(fixture.start()).rejects.toThrow(/workspace|thread|permissions|generation|stale/i);
    expect(transport.sent.map(message => message.method)).not.toContain('thread/start');
    expect(transport.sent.map(message => message.method)).not.toContain('turn/start');
  });

  it('accounts only matching turn increments across replay and duplicate updates', async () => {
    const { start, transport, sessionId, previousTurn, turnId } = nativeFixture();
    const execution = await start();
    expect(transport.sent.find(message => message.method === 'thread/resume')?.params).toEqual({ threadId: sessionId, excludeTurns: true });
    const last = { inputTokens: 3, outputTokens: 1, totalTokens: 4 };
    const update = (id: string, count: number) => transport.push({ method: 'thread/tokenUsage/updated', params: {
      threadId: sessionId, turnId: id, tokenUsage: { last, total: { inputTokens: 10 + count * 3, outputTokens: 2 + count, totalTokens: 12 + count * 4 } } } });
    update(previousTurn, 0);
    update(turnId, 1);
    update(turnId, 1);
    update(turnId, 2);
    transport.push({ method: 'turn/completed', params: { threadId: sessionId, turn: { id: turnId, status: 'completed' } } });
    expect(await execution.waitForResult({ contextHighTokens: 8 })).toMatchObject({ status: 'context_high',
      sessionId, usage: { inputTokens: 6, outputTokens: 2, totalTokens: 8 }, cumulativeSessionTokens: 20 });
    expect(await execution.captureSession()).toMatchObject({ sessionId, generation: 1, checkpoint: { turnId, total: { totalTokens: 20 } } });
    expect((await execution.waitForResult()).status).toBe('context_high');
  });

  it.each(['interactive', 'endpoint', 'analysis', 'untrusted host', 'invalid UUID'])('rejects %s before opening a transport', async reason => {
    const { opts } = nativeFixture();
    const selection = { ...runtime };
    if (reason === 'interactive') opts.executionMode = 'interactive';
    if (reason === 'endpoint') selection.endpoint = 'ws://localhost';
    if (reason === 'analysis') opts.executionProfile = 'analysis';
    if (reason === 'untrusted host') opts.sandbox.localProcessWorkspace = false;
    if (reason === 'invalid UUID') opts.resume.sessionId = opts.resume.checkpoint.sessionId = 'latest';
    const open = vi.fn();
    await expect(CodexAppServerExecution.start(opts, selection, open)).rejects.toThrow();
    expect(open).not.toHaveBeenCalled();
  });

  it('marks an unconfirmed native turn dispatch as unsafe to retry', async () => {
    const { start, transport } = nativeFixture();
    transport.results.set('turn/start', null);
    await expect(start()).rejects.toBeInstanceOf(NativeResumeDispatchError);
    expect(transport.sent.filter(message => message.method === 'turn/start')).toHaveLength(1);
    expect(transport.sent.some(message => message.method === 'thread/start')).toBe(false);
  });

  it('propagates the native writer conflict before sending another turn', async () => {
    const { start, transport } = nativeFixture();
    const send = transport.send.bind(transport);
    vi.spyOn(transport, 'send').mockImplementation(async message => {
      if (message.method !== 'thread/resume') return send(message);
      transport.push({ id: message.id, error: { code: -32600, message: 'thread has an active writer: private detail' } });
    });
    const failure = await start().catch(error => error);
    expect(failure).toBeInstanceOf(NativeResumeDispatchError);
    expect(failure.message).toBe('Codex native thread has an active writer');
    expect(transport.sent.map(message => message.method)).not.toContain('turn/start');
  });

  it.each(['jump', 'changed duplicate', 'swapped counts'])('retains only confirmed usage after a %s', async mode => {
    const { start, transport, sessionId, turnId } = nativeFixture();
    const execution = await start();
    const counts = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
    const update = (total: ReturnType<typeof counts>, last: ReturnType<typeof counts>) => transport.push({
      method: 'thread/tokenUsage/updated', params: { threadId: sessionId, turnId, tokenUsage: { total, last } },
    });
    update(counts(13, 3), counts(3, 1));
    if (mode === 'jump') update(counts(1000, 4), counts(2000, 1));
    if (mode === 'changed duplicate') update(counts(13, 3), counts(2, 2));
    if (mode === 'swapped counts') update(counts(16, 4), counts(1, 3));
    expect(await execution.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'NATIVE_USAGE_UNCONFIRMED' },
      usage: counts(3, 1), cumulativeSessionTokens: 16 });
    expect(await execution.captureSession()).toBeUndefined();
  });

  it.each(['foreign inner id', 'foreign outer id', 'missing status', 'non-string status'])('rejects native completion with %s', async mode => {
    const { start, transport, sessionId, turnId, previousTurn } = nativeFixture();
    const execution = await start();
    transport.push({ method: 'thread/tokenUsage/updated', params: { threadId: sessionId, turnId, tokenUsage: {
      total: { inputTokens: 13, outputTokens: 3, totalTokens: 16 }, last: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } } } });
    transport.push({ method: 'item/completed', params: { threadId: sessionId, turnId, item: {
      type: 'agentMessage', text: '<goal_complete>{"type":"goal_complete"}</goal_complete>' } } });
    transport.push({ method: 'turn/completed', params: { threadId: sessionId, turnId: mode === 'foreign outer id' ? previousTurn : turnId,
      turn: { id: mode === 'foreign inner id' ? previousTurn : turnId,
        ...(mode !== 'missing status' && { status: mode === 'non-string status' ? true : 'completed' }) } } });
    expect(await execution.waitForResult({ contextHighTokens: 1 })).toMatchObject({ status: 'failed', error: { code: 'NATIVE_TURN_UNCONFIRMED' } });
    expect(await execution.captureSession()).toBeUndefined();
  });

  it('does not attribute historical usage to a turn without a current usage event', async () => {
    const { start, transport, sessionId, turnId } = nativeFixture();
    const execution = await start();
    transport.push({ method: 'turn/completed', params: { threadId: sessionId, turn: { id: turnId, status: 'completed' } } });
    const result = await execution.waitForResult();
    expect(result).toMatchObject({ status: 'failed', cumulativeSessionTokens: 12, error: { code: 'NATIVE_USAGE_UNCONFIRMED' } });
    expect(result.usage).toBeUndefined();
    expect(await execution.captureSession()).toBeUndefined();
  });

  it('fails closed on a missing or inconsistent cumulative baseline', async () => {
    const { start, transport, sessionId, turnId } = nativeFixture();
    const execution = await start();
    transport.push({ method: 'thread/tokenUsage/updated', params: { threadId: sessionId, turnId, tokenUsage: {
      last: { inputTokens: 3, outputTokens: 1, totalTokens: 4 }, total: { inputTokens: 30, outputTokens: 7, totalTokens: 37 } } } });
    expect(await execution.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'NATIVE_USAGE_UNCONFIRMED' } });
    expect(await execution.captureSession()).toBeUndefined();
  });
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
        tokenUsage: { total: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } },
      },
    });
    transport.push({
      jsonrpc: '2.0', method: 'thread/tokenUsage/updated',
      params: {
        tokenUsage: {
          total: { inputTokens: 12, cachedInputTokens: 4, outputTokens: 5, reasoningOutputTokens: 2, totalTokens: 17 },
          last: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      },
    });
    transport.push({
      jsonrpc: '2.0', method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } },
    });

    await expect(execution.waitForResult({ completionTimeoutMs: 5_000 })).resolves.toMatchObject({
      status: 'completed',
      provider: 'app-server',
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

  it('gives up on a turn that stops talking', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);

    const result = await execution.waitForResult({ completionTimeoutMs: 600_000, idleTimeoutMs: 30 });

    expect(result.status).toBe('timed_out');
    expect(result.error).toMatchObject({ code: 'AGENT_IDLE' });
  });

  it('re-arms the idle watchdog whenever the agent reports something', async () => {
    const transport = new ScriptedTransport();
    const execution = await CodexAppServerExecution.start(options(), runtime, () => transport);
    const pending = execution.waitForResult({ completionTimeoutMs: 600_000, idleTimeoutMs: 200 });

    // The agent keeps saying something, so the watchdog never fires — it
    // keeps re-arming on every notification.
    for (let i = 0; i < 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 80));
      transport.push({ jsonrpc: '2.0', method: 'item/started', params: {
        threadId: 'thread-1', turnId: 'turn-1', startedAtMs: 1791849600000,
        item: { id: `cmd-${i}`, type: 'commandExecution', command: 'work', status: 'inProgress', exitCode: null },
      } });
    }
    await execution.interrupt('manual');

    const result = await pending;
    expect(result.status).toBe('aborted');
    expect(result.error?.code).not.toBe('AGENT_IDLE');
  });});
