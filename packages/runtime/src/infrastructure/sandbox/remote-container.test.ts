import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentExecutionOptions, AgentStartOptions, NativeSessionCheckpoint, SessionSnapshot } from '../../domain/agents/types.js';
import { CursorProvider } from '../../domain/agents/cursor.js';
import { PiProvider } from '../../domain/agents/pi.js';
import { CodexProvider } from '../../domain/agents/codex.js';
import {
  createRemoteContainerCliTransport, createRemoteContainerHttpTransport,
  RemoteContainerSandboxProvider, type RemoteContainerTransport,
} from './remote-container.js';

const servers = new Set<Server>();
const directories = new Set<string>();
afterEach(async () => {
  await Promise.all([...servers].map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  })));
  servers.clear();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  directories.clear();
});

async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: unknown) => void): Promise<string> {
  const server = createServer(async (request, response) => {
    let content = '';
    for await (const chunk of request) content += chunk.toString();
    handler(request, response, content ? JSON.parse(content) : undefined);
  });
  servers.add(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server has no TCP port');
  return `http://127.0.0.1:${address.port}/api/`;
}

function respond(response: ServerResponse, value: unknown): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

const metadata = { provider: 'codex', transport: 'exec' as const };
const info = { id: 'execution-1', sessionId: 'session-1', metadata };
const snapshot = { sessionId: 'session-1', generation: 1, checkpoint: { cursor: 'checkpoint' }, summary: '', capturedAt: '2026-11-06T12:00:00Z' };
const result = { version: 1, runId: 'run-1', status: 'completed', provider: 'codex', sessionId: 'session-1', exitCode: 0, commits: [] };
const start: AgentStartOptions = { command: { argv: ['codex', 'exec', 'hello'] }, metadata, generation: 1, prompt: 'hello', signalType: 'goal_complete' };

function fakeTransport(response: (operation: string) => unknown): RemoteContainerTransport {
  return { kind: 'http', request: vi.fn(async operation => response(operation)) };
}

describe('real remote container HTTP transport', () => {
  it('sends authenticated JSON to the base path and runs a complete agent lifecycle', async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    let nextEvent = 0;
    const baseUrl = await serve((request, response, body) => {
      expect(request.headers.authorization).toBe('Bearer test-token');
      calls.push({ path: request.url!, body });
      switch (request.url) {
        case '/api/health': respond(response, { healthy: true }); break;
        case '/api/workspace.create': respond(response, { iid: 1, path: '/workspace', branch: 'feature' }); break;
        case '/api/sandbox.create': respond(response, { id: 'sandbox-1', workspacePath: '/workspace' }); break;
        case '/api/agent.start': respond(response, info); break;
        case '/api/agent.event.next': respond(response, nextEvent++ === 0 ? { type: 'text', text: 'progress' } : null); break;
        case '/api/agent.output': respond(response, { output: 'captured text' }); break;
        case '/api/agent.capture-session': respond(response, snapshot); break;
        case '/api/agent.resume': respond(response, { ...info, id: 'execution-2' }); break;
        case '/api/agent.wait': respond(response, result); break;
        default: respond(response, { ok: true });
      }
    });
    const transport = createRemoteContainerHttpTransport({ baseUrl, token: 'test-token' });
    expect(await transport.health!()).toBe(true);
    const provider = new RemoteContainerSandboxProvider(transport);
    expect(await provider.createWorktree({ iid: 1, baseBranch: 'main' })).toEqual({ iid: 1, path: '/workspace', branch: 'feature' });
    const sandbox = await provider.create({ worktreePath: '/workspace', session: 'session-1' });
    const execution = await sandbox.startAgent({ ...start, parseLine: () => [] });
    expect(await execution.waitForEvent()).toEqual({ type: 'text', text: 'progress' });
    expect(await execution.captureOutput()).toBe('captured text');
    expect(await execution.captureSession()).toEqual(snapshot);
    await expect(execution.resume({ snapshot })).rejects.toThrow(/interrupt or finish/);
    await execution.interrupt('manual');
    const resumed = await execution.resume({ snapshot });
    expect(resumed.id).toBe('execution-2');
    await expect(execution.captureOutput()).rejects.toThrow(/superseded/);
    expect(await resumed.waitForResult({ completionTimeoutMs: 1000 })).toEqual(result);
    expect(await resumed.waitForResult()).toEqual(result);
    expect(await resumed.waitForEvent()).toBeNull();
    expect(calls.filter(call => call.path === '/api/agent.wait')).toHaveLength(1);
    expect((calls.find(call => call.path === '/api/agent.start')!.body as { options: unknown }).options).not.toHaveProperty('parseLine');
    await sandbox.close();
    await sandbox.close();
    await expect(resumed.captureOutput()).rejects.toThrow(/closed/);
    await expect(sandbox.startAgent(start)).rejects.toThrow(/closed/);
    expect(calls.filter(call => call.path === '/api/sandbox.close')).toHaveLength(1);
  });

  it.each(['status', 'json', 'shape', 'content-type'] as const)('rejects invalid HTTP %s', async mode => {
    const baseUrl = await serve((_request, response) => {
      if (mode === 'status') { response.writeHead(403); response.end('forbidden'); }
      else if (mode === 'json') { response.setHeader('content-type', 'application/json'); response.end('{broken'); }
      else if (mode === 'shape') respond(response, null);
      else { response.setHeader('content-type', 'text/html'); response.end('<html>login</html>'); }
    });
    const transport = createRemoteContainerHttpTransport({ baseUrl });
    await expect(transport.request('sandbox.create', { worktreePath: '/workspace', session: 'test' })).rejects.toThrow(mode === 'status' ? /HTTP 403/ : mode === 'json' ? /invalid JSON/ : mode === 'shape' ? /invalid remote container response/ : /non-JSON/);
  });

  it.each(['timeout', 'abort'] as const)('aborts the actual HTTP response body on %s', async mode => {
    let bodyStarted!: () => void;
    const started = new Promise<void>(resolve => { bodyStarted = resolve; });
    const baseUrl = await serve((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.write('{');
      bodyStarted();
    });
    const controller = new AbortController();
    const transport = createRemoteContainerHttpTransport({ baseUrl, timeoutMs: mode === 'timeout' ? 100 : 5000 });
    const outcome = expect(transport.request('sandbox.create', { worktreePath: '/workspace', session: 'test' }, { signal: controller.signal }))
      .rejects.toMatchObject({ name: mode === 'timeout' ? 'TimeoutError' : 'AbortError' });
    await started;
    if (mode === 'abort') controller.abort();
    await outcome;
  });

  it('rejects unsupported operations and unsafe URLs without issuing requests', async () => {
    expect(() => createRemoteContainerHttpTransport({ baseUrl: 'file:///tmp/socket' })).toThrow(/HTTP/);
    expect(() => createRemoteContainerHttpTransport({ baseUrl: 'https://user:pass@example.test' })).toThrow(/credentials/);
    const fetch = vi.fn();
    const transport = createRemoteContainerHttpTransport({ baseUrl: 'https://example.test', fetch });
    await expect(Reflect.apply(transport.request, transport, ['../redirect', {}])).rejects.toThrow(/unsupported/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('remote response and state validation', () => {
  it.each((['cursor', 'pi'] as const).flatMap(name => ['/workspace/repo', '/workspace/repo/', '/'].map(nativeCwd => ({ name, nativeCwd }))))
    ('binds $name captures to both canonical host and native cwd $nativeCwd', async ({ name, nativeCwd }) => {
    const worktreePath = '/server/canonical/repo';
    const workspacePath = nativeCwd === '/' ? '/' : '/workspace/repo';
    const captured: SessionSnapshot = { sessionId: 'native-bound', generation: 1, summary: '',
      capturedAt: '2026-11-13T00:00:00Z',
      checkpoint: { version: 1, provider: name, sessionId: 'native-bound', worktreePath, workspacePath } };
    let response = captured;
    const transport = fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox', worktreePath, workspacePath: nativeCwd }
      : operation === 'agent.start' || operation === 'agent.resume' ? { id: operation, metadata: { provider: name, transport: 'process' } }
      : operation === 'agent.capture-session' ? response : { ok: true });
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/server/link/repo', session: 'session' });
    expect(sandbox.worktreePath).toBe(worktreePath);
    expect(sandbox.workspacePath).toBe(nativeCwd);
    const provider = name === 'cursor' ? new CursorProvider() : new PiProvider();
    const options: AgentExecutionOptions = { sandbox, worktreePath, sessionId: 'logical', generation: 1,
      prompt: 'test', signalType: 'goal_complete', executionMode: 'batch' };
    for (const invalid of ['/server/other/repo', workspacePath]) {
      await expect(provider.createExecution({ ...options, worktreePath: invalid })).rejects.toThrow(/workspace/);
    }
    const execution = await provider.createExecution(options);
    expect(await execution.captureSession()).toEqual(captured);
    for (const change of [{ worktreePath: '/server/other/repo' }, { worktreePath: workspacePath },
      { workspacePath: '/workspace/other' }, { workspacePath: 'workspace/repo' }, { workspacePath: '/workspace/repo\\' },
      { workspacePath: undefined }, { provider: name === 'cursor' ? 'pi' : 'cursor' }]) {
      response = { ...captured, checkpoint: { ...captured.checkpoint as NativeSessionCheckpoint, ...change } };
      await expect(execution.captureSession()).rejects.toThrow(/identity/);
    }
    response = captured;
    const saved = (await execution.captureSession())!;
    await execution.interrupt('manual');
    await execution.kill();
    const resumed = await provider.createExecution({ ...options, resume: saved, generation: 2 });
    expect(transport.request).toHaveBeenCalledWith('agent.resume', { sandboxId: sandbox.id, executionId: execution.id,
      options: { snapshot: saved, prompt: options.prompt } }, undefined);
    response = { ...captured, generation: 2 };
    expect(await resumed.captureSession()).toEqual(response);
    await sandbox.close();
  });

  it.each([undefined, '/server/repo', '/workspace/repo'])('uses the requested host when a legacy backend omits worktreePath and workspacePath=%s', async workspacePath => {
    const sandbox = await new RemoteContainerSandboxProvider(fakeTransport(() => ({ id: 'sandbox', workspacePath })))
      .create({ worktreePath: '/server/repo', session: 'session' });
    expect(sandbox.worktreePath).toBe('/server/repo');
    expect(sandbox.workspacePath).toBe(workspacePath ?? '/server/repo');
  });

  it.each(['cursor', 'pi'] as const)('preserves %s legacy same-namespace captures with a trailing host slash', async name => {
    const worktreePath = '/legacy/repo/';
    const captured: SessionSnapshot = { sessionId: 'legacy-native', generation: 0, summary: '', capturedAt: '2026-11-13T00:00:00Z',
      checkpoint: { version: 1, provider: name, sessionId: 'legacy-native', worktreePath } };
    const transport = fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox', workspacePath: worktreePath }
      : operation === 'agent.start' || operation === 'agent.resume' ? { id: operation, metadata: { provider: name, transport: 'process' } }
      : operation === 'agent.capture-session' ? captured : { ok: true });
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath, session: 'legacy' });
    const provider = name === 'cursor' ? new CursorProvider() : new PiProvider();
    const options: AgentExecutionOptions = { sandbox, worktreePath, sessionId: 'logical', generation: 0,
      prompt: 'legacy', signalType: 'goal_complete', executionMode: 'batch' };
    const execution = await provider.createExecution(options);
    expect(await execution.captureSession()).toEqual(captured);
    await execution.interrupt('manual');
    await expect(provider.createExecution({ ...options, resume: captured, generation: 1 })).resolves.toBeDefined();
    await sandbox.close();
  });

  it('keeps logical execution sessions separate from confirmed native metadata', async () => {
    let value: unknown = { ...result, metadata: { ...metadata, threadId: 'confirmed-native' } };
    const transport = fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox' }
      : operation === 'agent.start' ? info : value);
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/workspace', session: 'session' });
    const execution = await sandbox.startAgent(start);
    await execution.waitForResult();
    expect(execution.metadata.threadId).toBe('confirmed-native');
    expect(execution.sessionId).toBe('session-1');
    value = result;
    const legacy = await sandbox.startAgent(start);
    await legacy.waitForResult();
    expect(legacy.metadata.threadId).toBeUndefined();
  });

  it('rejects result metadata from a different provider', async () => {
    const transport = fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox' }
      : operation === 'agent.start' ? info : { ...result, metadata: { provider: 'other', transport: 'process' } });
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/workspace', session: 'session' });
    await expect((await sandbox.startAgent(start)).waitForResult()).rejects.toThrow(/provider/);
  });

  it('clears a previously observed native identity when the server invalidates it', async () => {
    const nativeMetadata = { provider: 'cursor', transport: 'process' as const, threadId: 'native-first' };
    const invalidated = { ...result, provider: 'cursor', status: 'failed', sessionId: undefined,
      metadata: { provider: 'cursor', transport: 'process' },
      error: { code: 'NATIVE_SESSION_MISMATCH', message: 'identity changed' } };
    const transport = fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox' }
      : operation === 'agent.start' ? { ...info, sessionId: 'native-first', metadata: nativeMetadata } : invalidated);
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/workspace', session: 'session' });
    const execution = await sandbox.startAgent({ ...start, metadata: nativeMetadata });
    expect(execution.metadata.threadId).toBe('native-first');
    expect((await execution.waitForResult()).status).toBe('failed');
    expect(execution.metadata.threadId).toBeUndefined();
    expect(execution.sessionId).toBeUndefined();
  });

  it.each(['failed', 'aborted', 'timed_out'] as const)('discards a captured snapshot after authoritative invalidation with status=%s', async status => {
    let finishCapture!: (value: unknown) => void;
    const nativeMetadata = { provider: 'cursor', transport: 'process' as const, threadId: 'native-first' };
    const captured = { ...snapshot, sessionId: 'native-first', generation: 0,
      checkpoint: { version: 1, provider: 'cursor', sessionId: 'native-first', worktreePath: '/workspace' } };
    const transport = fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox' }
      : operation === 'agent.start' ? { id: 'execution', sessionId: 'native-first', metadata: nativeMetadata }
      : operation === 'agent.capture-session' ? new Promise(resolve => { finishCapture = resolve; })
      : { ...result, provider: 'cursor', status, sessionInvalidated: true, sessionId: undefined,
        metadata: { provider: 'cursor', transport: 'process' }, error: { code: 'NATIVE_SESSION_MISMATCH', message: 'identity changed' } });
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/workspace', session: 'session' });
    const execution = await sandbox.startAgent({ ...start, generation: 0, metadata: nativeMetadata });
    const pending = execution.captureSession();
    await execution.waitForResult();
    finishCapture(captured);
    expect(await pending).toBeUndefined();
    expect(execution.sessionId).toBeUndefined();
    expect(execution.metadata.threadId).toBeUndefined();
    await expect(execution.resume({ snapshot: captured })).rejects.toThrow(/identity/);
  });

  it('forwards a Codex exec runtime to its remote provider without executing it locally', async () => {
    const calls: unknown[] = [];
    const transport: RemoteContainerTransport = { kind: 'http', request: vi.fn(async (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === 'sandbox.create') return { id: 'sandbox', workspacePath: '/workspace' };
      return info;
    }) };
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/workspace', session: 'session' });
    const runtime = { kind: 'codex' as const, transport: 'exec' as const, auth: 'api' as const,
      provider: 'custom', profile: 'work', startupTimeoutMs: 5000 };
    const options = { sandbox, worktreePath: '/workspace', sessionId: 'session', prompt: 'continue',
      signalType: 'goal_complete' as const, generation: 1, executionMode: 'batch' as const, runtime };
    await new CodexProvider().createExecution(options);
    expect(calls).toContainEqual({ operation: 'agent.start', payload: { sandboxId: 'sandbox', options: expect.objectContaining({ runtime }) } });
    const before = calls.length;
    await expect(new CodexProvider().createExecution({ ...options, runtime: { ...runtime, transport: 'app-server' } })).rejects.toThrow(/runtime/);
    expect(calls).toHaveLength(before);
  });

  it.each([undefined, null, {}, { status: 'completed', provider: 'codex' }, { ...result, status: 'unknown' }, { ...result, commits: null }, { ...result, exitCode: 5 }, { ...result, error: { code: 'failure', message: 'failed' } }, { ...result, sessionInvalidated: true }])
    ('does not treat an invalid result as success: %j', async invalid => {
      const provider = new RemoteContainerSandboxProvider(fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox' } : operation === 'agent.start' ? info : invalid));
      const sandbox = await provider.create({ worktreePath: '/workspace', session: 'session' });
      const execution = await sandbox.startAgent(start);
      await expect(execution.waitForResult()).rejects.toThrow();
    });

  it('validates event payloads, snapshots and capture output', async () => {
    let response: unknown;
    const provider = new RemoteContainerSandboxProvider(fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox' } : operation === 'agent.start' ? info : response));
    const execution = await (await provider.create({ worktreePath: '/workspace', session: 'session' })).startAgent(start);
    response = { type: 'unknown' };
    await expect(execution.waitForEvent()).rejects.toThrow(/invalid remote/);
    response = { type: 'usage', usage: { inputTokens: -1, outputTokens: 2, totalTokens: 1 } };
    await expect(execution.waitForEvent()).rejects.toThrow(/invalid remote/);
    response = { type: 'error', error: { message: 'remote failed' } };
    const event = await execution.waitForEvent();
    expect(event).toMatchObject({ type: 'error', error: expect.any(Error) });
    response = undefined;
    await expect(execution.captureOutput()).rejects.toThrow(/invalid remote/);
    await expect(execution.captureSession()).rejects.toThrow(/invalid remote/);
    response = { ...snapshot, checkpoint: undefined, generation: 'one' };
    await expect(execution.captureSession()).rejects.toThrow(/invalid remote/);
    const { checkpoint: _checkpoint, ...incomplete } = snapshot;
    response = incomplete;
    await expect(execution.captureSession()).rejects.toThrow(/checkpoint/);
    response = null;
    expect(await execution.captureSession()).toBeUndefined();
  });

  it('does not advance interrupt/close state without a positive acknowledgement', async () => {
    let acknowledgement: unknown = null;
    const transport = fakeTransport(operation => operation === 'sandbox.create' ? { id: 'sandbox' } : operation === 'agent.start' ? info : operation === 'agent.resume' ? { ...info, id: 'resumed' } : acknowledgement);
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/workspace', session: 'session' });
    const execution = await sandbox.startAgent(start);
    await expect(execution.interrupt('manual')).rejects.toThrow(/invalid remote/);
    await expect(execution.resume({ snapshot })).rejects.toThrow(/interrupt or finish/);
    await expect(sandbox.close()).rejects.toThrow(/invalid remote/);
    acknowledgement = { ok: true };
    await execution.kill();
    const resumed = await execution.resume({ snapshot });
    expect(resumed.id).toBe('resumed');
    await sandbox.close();
  });

  it('prevents concurrent resumes and stale wait responses from reviving the old execution', async () => {
    let finishWait!: (value: unknown) => void;
    let finishResume!: (value: unknown) => void;
    const transport = fakeTransport(operation => {
      if (operation === 'sandbox.create') return { id: 'sandbox' };
      if (operation === 'agent.start') return info;
      if (operation === 'agent.wait') return new Promise(resolve => { finishWait = resolve; });
      if (operation === 'agent.resume') return new Promise(resolve => { finishResume = resolve; });
      return { ok: true };
    });
    const execution = await (await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/workspace', session: 'session' })).startAgent(start);
    const wait = expect(execution.waitForResult()).rejects.toThrow(/resuming/);
    await execution.interrupt('manual');
    const resume = execution.resume({ snapshot });
    await expect(execution.resume({ snapshot })).rejects.toThrow(/resuming/);
    finishWait(result);
    await wait;
    finishResume({ ...info, id: 'resumed' });
    expect((await resume).id).toBe('resumed');
    await expect(execution.waitForResult()).rejects.toThrow(/superseded/);
  });
});

describe.each([
  { name: 'cursor', create: () => new CursorProvider() },
  { name: 'pi', create: () => new PiProvider() },
])('$name provider-managed remote sessions', ({ name, create }) => {
  async function fixture() {
    const nativeSnapshot: SessionSnapshot = { sessionId: 'native-captured', generation: 1,
      checkpoint: { version: 1, provider: name, sessionId: 'native-captured', worktreePath: '/workspace' },
      summary: 'native history', capturedAt: '2026-11-13T00:00:00Z' };
    let nextSnapshot = nativeSnapshot;
    const calls: Array<{ operation: string; payload: unknown }> = [];
    const transport: RemoteContainerTransport = { kind: 'http', request: vi.fn(async (operation, payload) => {
      calls.push({ operation, payload });
      if (operation === 'sandbox.create') return { id: 'sandbox', workspacePath: '/workspace' };
      if (operation === 'agent.start') return { id: 'first', metadata: { provider: name, transport: 'process' } };
      if (operation === 'agent.resume') return { id: 'second', metadata: { provider: name, transport: 'process' } };
      if (operation === 'agent.wait') return { ...result, provider: name, sessionId: 'native-captured' };
      if (operation === 'agent.capture-session') return nextSnapshot;
      return { ok: true };
    }) };
    const sandbox = await new RemoteContainerSandboxProvider(transport).create({ worktreePath: '/workspace', session: 'logical', executionMode: 'batch' });
    const options: AgentExecutionOptions = { sandbox, worktreePath: '/workspace', sessionId: 'logical', generation: 1,
      prompt: 'first prompt', signalType: 'goal_complete', executionMode: 'batch' };
    return { nativeSnapshot, calls, options, sandbox, setSnapshot: (value: SessionSnapshot) => { nextSnapshot = value; } };
  }

  it('uses server-confirmed results and capture, and routes provider.createExecution to the captured execution resume', async () => {
    const host = await fixture();
    const provider = create();
    const fresh = await provider.createExecution(host.options);
    expect(await fresh.waitForResult()).toMatchObject({ status: 'completed', provider: name, sessionId: 'native-captured' });
    const captured = (await fresh.captureSession())!;
    expect(captured).toEqual(host.nativeSnapshot);
    expect(fresh.metadata.threadId).toBe(captured.sessionId);
    const resumed = await provider.createExecution({ ...host.options, resume: captured, generation: 2, prompt: 'continued prompt' });
    expect(await resumed.waitForResult()).toMatchObject({ status: 'completed', sessionId: captured.sessionId });
    expect(host.calls.filter(call => call.operation === 'agent.start')).toHaveLength(1);
    expect(host.calls.filter(call => call.operation === 'agent.resume')).toEqual([{ operation: 'agent.resume',
      payload: { sandboxId: 'sandbox', executionId: 'first', options: { snapshot: captured, prompt: 'continued prompt' } } }]);
    await expect(fresh.captureOutput()).rejects.toThrow(/superseded/);
  });

  it('rejects foreign snapshots, incorrect generations and interactive mode before issuing any start or resume', async () => {
    const host = await fixture();
    const provider = create();
    await expect(provider.createExecution({ ...host.options, resume: host.nativeSnapshot, generation: 2 })).rejects.toThrow(/captured/);
    await expect(provider.createExecution({ ...host.options, executionMode: 'interactive' })).rejects.toThrow(/batch/);
    expect(host.calls.filter(call => call.operation.startsWith('agent.'))).toHaveLength(0);
    const fresh = await provider.createExecution(host.options);
    await fresh.waitForResult();
    const captured = (await fresh.captureSession())!;
    for (const generation of [0, 1, 3, -1, Number.NaN]) {
      await expect(provider.createExecution({ ...host.options, resume: captured, generation })).rejects.toThrow(/generation/);
    }
    await expect(provider.createExecution({ ...host.options, resume: { ...captured, summary: 'replaced' }, generation: 2 })).rejects.toThrow(/captured/);
    expect(host.calls.filter(call => call.operation === 'agent.start')).toHaveLength(1);
    expect(host.calls.filter(call => call.operation === 'agent.resume')).toHaveLength(0);
  });

  it('rejects server snapshots with foreign native identity, provider, cwd, version or generation', async () => {
    const host = await fixture();
    const fresh = await create().createExecution(host.options);
    await fresh.waitForResult();
    const checkpoint = host.nativeSnapshot.checkpoint as NativeSessionCheckpoint;
    for (const replacement of [
      { ...host.nativeSnapshot, sessionId: 'foreign-id' },
      { ...host.nativeSnapshot, generation: 2 },
      ...[{ provider: 'foreign' }, { worktreePath: '/elsewhere' }, { version: 2 }, { sessionId: 'foreign-id' }]
        .map(change => ({ ...host.nativeSnapshot, checkpoint: { ...checkpoint, ...change } })),
    ]) {
      host.setSnapshot(replacement);
      await expect(fresh.captureSession()).rejects.toThrow(/native session|generation|identity/);
    }
  });
});

describe('real CLI protocol client', () => {
  it('requires an explicit command instead of assuming a nonexistent executable', () => {
    expect(() => createRemoteContainerCliTransport()).toThrow(/explicitly configured/);
  });

  it('runs an executable, reports nonzero exits and rejects bad JSON', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'remote-client-'));
    directories.add(directory);
    const command = join(directory, 'client.mjs');
    writeFileSync(command, '#!/usr/bin/env node\nconst payload = JSON.parse(process.argv[3]); if (payload.executionId === "fail") { console.error("client failed"); process.exit(7); } else if (payload.executionId === "bad") { console.log("{broken"); } else { console.log(JSON.stringify({output: payload.sandboxId})); }\n', { mode: 0o755 });
    const transport = createRemoteContainerCliTransport({ command });
    expect(await transport.request('agent.output', { sandboxId: 'literal $HOME; hello', executionId: 'output' })).toEqual({ output: 'literal $HOME; hello' });
    await expect(transport.request('agent.output', { sandboxId: 'sandbox', executionId: 'fail' })).rejects.toThrow(/client failed/);
    await expect(transport.request('agent.output', { sandboxId: 'sandbox', executionId: 'bad' })).rejects.toThrow(/invalid JSON/);
  });
});
