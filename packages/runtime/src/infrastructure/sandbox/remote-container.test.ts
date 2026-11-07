import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentStartOptions } from '../../domain/agents/types.js';
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
  it.each([undefined, null, {}, { status: 'completed', provider: 'codex' }, { ...result, status: 'unknown' }, { ...result, commits: null }, { ...result, exitCode: 5 }, { ...result, error: { code: 'failure', message: 'failed' } }])
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
