import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProviderRegistry } from '../../domain/agents/registry.js';
import { CursorProvider } from '../../domain/agents/cursor.js';
import { PiProvider } from '../../domain/agents/pi.js';
import { CodexProvider } from '../../domain/agents/codex.js';
import { attemptNativeResume } from '../../application/workflows/resume.js';
import type { AgentExecution, AgentExecutionOptions, AgentProvider, AgentStartOptions, NativeSessionCheckpoint, SessionSnapshot } from '../../domain/agents/types.js';
import { WorktreeManager } from '../git/index.js';
import { SandboxProviderRegistry } from './registry.js';
import { ContainerSandbox } from './container/sandbox.js';
import type { ContainerCreateOptions, ContainerProvider } from './container/types.js';
import { createRemoteContainerHttpTransport, RemoteContainerSandboxProvider } from './remote-container.js';
import { createRemoteContainerServer, type RemoteContainerServer, type RemoteContainerServerOptions } from './remote-container-server.js';

const token = 'local-test-bearer-token-at-least-32-bytes';
const resources: Array<{ service: RemoteContainerServer; server: Server; directory: string }> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const { service, server } of resources) {
    await service.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  resources.length = 0;
  for (const directory of temporaryDirectories) rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function nodeAgent(script?: string): AgentProvider {
  return {
    name: 'node-fixture', capabilities: new Set(),
    createExecution: vi.fn(async options => options.sandbox.startAgent({
      command: {
        argv: [process.execPath, '-e', script ?? `
          const fs = require('node:fs');
          fs.writeFileSync('executed.json', JSON.stringify({ cwd: process.cwd(), injected: process.env.CLIENT_INJECTED ?? null }));
          console.log(JSON.stringify({type:'result', result:'<goal_complete>{"type":"goal_complete","summary":"trusted node executed"}</goal_complete>'}));
        `],
        cwd: options.worktreePath,
      },
      metadata: { provider: 'node-fixture', transport: 'process' },
      generation: options.generation, prompt: options.prompt, signalType: options.signalType, executionMode: 'batch',
    })),
  };
}

const start: AgentStartOptions = {
  command: { argv: ['untrusted-program', '--arbitrary-command'], cwd: '/', env: { CLIENT_INJECTED: 'bad' } },
  metadata: { provider: 'node-fixture', transport: 'process' }, generation: 0,
  prompt: 'run the trusted fixture', signalType: 'goal_complete', executionMode: 'batch',
};

async function setup(overrides: Partial<RemoteContainerServerOptions> = {}, agent = nodeAgent()) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'remote-protocol-')));
  temporaryDirectories.push(directory);
  const root = join(directory, 'workspaces');
  mkdirSync(root);
  const options: RemoteContainerServerOptions = {
    enabled: true, token, workspaceRoot: root,
    sandboxes: new SandboxProviderRegistry().registerBuiltins(), sandboxProviderId: 'local',
    sandboxDeps: { worktreeManager: new WorktreeManager(directory) },
    agents: new AgentProviderRegistry([agent]), allowedAgents: [agent.name], basePath: '/api/',
    executionTimeoutMs: 5000, ...overrides,
  };
  const service = createRemoteContainerServer(options);
  const server = createServer(service.handle);
  resources.push({ service, server, directory });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  const baseUrl = `http://127.0.0.1:${address.port}/api/`;
  const transport = createRemoteContainerHttpTransport({ baseUrl, token, timeoutMs: 7000 });
  const provider = new RemoteContainerSandboxProvider(transport);
  const post = (operation: string, body: unknown) => fetch(`${baseUrl}${operation}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const createSandbox = () => provider.create({ worktreePath: root, session: 'node-test', executionMode: 'batch' });
  return { directory, root, options, service, server, baseUrl, transport, provider, post, createSandbox, agent };
}

async function nativeContainer(name: 'cursor' | 'pi' | 'codex', layout: 'single' | 'nested' | 'custom', reportedCwd?: string, workdirOverride?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'remote-native-container-')));
  temporaryDirectories.push(root);
  const host = join(root, layout === 'nested' ? 'repositories/api' : 'repo');
  mkdirSync(host, { recursive: true });
  const native = workdirOverride ?? (layout === 'custom' ? '/workspace/custom/tool cwd' : layout === 'nested' ? '/workspace/repositories/api' : '/workspace/repo');
  const agent = name === 'cursor' ? new CursorProvider() : name === 'pi' ? new PiProvider() : new CodexProvider();
  const createExecution = vi.spyOn(agent, 'createExecution');
  let mounts!: ContainerCreateOptions;
  const marker = '<goal_complete>{"type":"goal_complete","summary":"native fixture"}</goal_complete>';
  const engine: ContainerProvider = {
    engine: 'docker', binary: 'fixture-only', isAvailable: async () => true,
    create: vi.fn(async options => { mounts = options; return { id: 'fixture-container', name: options.name, engine: 'docker' as const }; }),
    exec: vi.fn(async options => {
      const cwd = reportedCwd ?? options.workdir;
      const lines = name === 'cursor' ? [
        { type: 'system', subtype: 'init', session_id: 'native-remote', cwd },
        { type: 'result', subtype: 'success', session_id: 'native-remote', result: marker },
      ] : name === 'pi' ? [
        { type: 'session', id: 'native-remote', cwd }, { type: 'agent_start' },
        { type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: marker }] } },
        { type: 'agent_settled' },
      ] : [{ type: 'thread.started', thread_id: 'native-codex' },
        { type: 'item.completed', item: { type: 'agent_message', text: marker } }];
      const resultDirectory = mounts.mounts.find(mount => mount.containerPath === '/afk/result')!.hostPath;
      const match = options.command[2].match(/\/afk\/result\/([^']+)\.stdout/)!;
      const base = join(resultDirectory, match[1]);
      writeFileSync(`${base}.stdout`, lines.map(line => JSON.stringify(line)).join('\n'));
      writeFileSync(`${base}.stderr`, '');
      writeFileSync(`${base}.exit`, '0');
      return { execId: match[1] };
    }),
    killExec: vi.fn(async () => {}), killContainer: vi.fn(async () => {}), remove: vi.fn(async () => {}),
    inspect: async () => ({ id: 'fixture-container', name: 'fixture', status: 'running' }),
  };
  let backend!: ContainerSandbox;
  const sandboxes = new SandboxProviderRegistry().register({
    metadata: { id: 'fixture', label: 'fixture', capabilities: new Set(), readiness: () => true, health: () => 'ready' },
    factory: () => ({ name: 'fixture', isolation: 'filesystem', capabilities: new Set(),
      createWorktree: async () => { throw new Error('fixture does not create worktrees'); }, create: async options => {
      backend = new ContainerSandbox({ worktreePath: options.worktreePath, workspaceRoot: options.workspaceRoot,
        workdir: layout === 'custom' ? native : undefined, image: 'fixture', user: '1000:1000' });
      backend.bindProvider(engine);
      await backend.createContainer();
      return backend;
    } }),
  });
  const service = createRemoteContainerServer({ enabled: true, token, workspaceRoot: root, sandboxes,
    sandboxProviderId: 'fixture', sandboxDeps: { worktreeManager: new WorktreeManager(root) },
    agents: new AgentProviderRegistry([agent]), allowedAgents: [name] });
  const post = (operation: string, body: unknown) => new Promise<{ status: number; body: unknown }>(resolve => {
    const request = Object.assign(new PassThrough(), { method: 'POST', url: `/${operation}`,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
    let status = 0;
    const response = { destroyed: false, writableEnded: false,
      writeHead(code: number) { status = code; }, end(json: string) { resolve({ status, body: JSON.parse(json) }); } };
    service.handle(request as unknown as IncomingMessage, response as unknown as ServerResponse);
    request.end(JSON.stringify(body));
  });
  const transport = createRemoteContainerHttpTransport({ request: async (operation, body) => {
    const response = await post(operation, body);
    if (response.status !== 200) throw new Error(`fixture HTTP ${response.status}: ${JSON.stringify(response.body)}`);
    return response.body;
  } });
  const provider = new RemoteContainerSandboxProvider(transport);
  const requestedHost = layout === 'nested' ? join(root, 'repo-link') : host;
  if (requestedHost !== host) symlinkSync(host, requestedHost);
  const sandbox = await provider.create({ worktreePath: requestedHost, session: 'native-fixture', executionMode: 'batch' });
  const options: AgentExecutionOptions = { sandbox, worktreePath: host, sessionId: 'logical-fixture', generation: 1,
    prompt: 'fresh', signalType: 'goal_complete', executionMode: 'batch' };
  return { host, native, agent, backend, engine, createExecution, sandbox, options, post, service, provider };
}

describe.each(['cursor', 'pi'] as const)('%s actual remote container path contract', name => {
  it.each(['single', 'nested', 'custom'] as const)('preserves host provenance and native cwd through capture and resume in %s layout', async layout => {
    const f = await nativeContainer(name, layout);
    try {
      expect(f.sandbox.worktreePath).toBe(f.host);
      expect(f.sandbox.workspacePath).toBe(f.native);
      const fresh = layout === 'custom' ? await f.sandbox.startAgent({ command: { argv: [name], cwd: f.native },
        metadata: { provider: name, transport: 'process' }, generation: 1, prompt: 'fresh',
        signalType: 'goal_complete', executionMode: 'batch' }) : await f.agent.createExecution(f.options);
      expect(await fresh.waitForResult()).toMatchObject({ status: 'completed', sessionId: 'native-remote' });
      const captured = (await fresh.captureSession())!;
      expect(captured.checkpoint).toEqual({ version: 1, provider: name, sessionId: 'native-remote', worktreePath: f.host, workspacePath: f.native });
      await fresh.interrupt('manual');
      await fresh.kill();
      for (const change of [{ worktreePath: f.native }, { workspacePath: '/workspace/elsewhere' }, { provider: 'codex' }]) {
        const denied = await f.post('agent.resume', { sandboxId: f.sandbox.id, executionId: fresh.id,
          options: { snapshot: { ...captured, checkpoint: { ...captured.checkpoint as NativeSessionCheckpoint, ...change } } } });
        expect(denied.status).toBe(403);
      }
      const other = await f.provider.create({ worktreePath: f.host, session: 'other', executionMode: 'batch' });
      await expect(f.agent.createExecution({ ...f.options, sandbox: other, resume: captured, generation: 2 })).rejects.toThrow(/captured/);
      await expect(f.agent.createExecution({ ...f.options, resume: captured, generation: 3 })).rejects.toThrow(/generation/);
      const resumed = await f.agent.createExecution({ ...f.options, resume: structuredClone(captured), generation: 2, prompt: 'continued' });
      expect(await resumed.waitForResult()).toMatchObject({ status: 'completed', sessionId: captured.sessionId });
      expect(f.createExecution.mock.calls.filter(([options]) => options.sandbox === f.backend)).toHaveLength(2);
      const serverStart = f.createExecution.mock.calls.find(([options]) => options.resume && !options.sandbox.startProviderExecution)![0];
      expect(serverStart.worktreePath).toBe(f.host);
      expect(serverStart.resume).toEqual(captured);
      expect(serverStart.generation).toBe(2);
      expect(f.engine.exec).toHaveBeenCalledTimes(2);
      expect(f.engine.exec).toHaveBeenLastCalledWith(expect.objectContaining({ workdir: f.native,
        command: expect.arrayContaining([name === 'cursor' ? '--resume' : '--session', captured.sessionId]) }));
      await expect(fresh.captureSession()).rejects.toThrow(/superseded/);
      await f.sandbox.close();
      await other.close();
    } finally { await f.service.close(); }
  });

  it('captures and resumes an equivalent custom native cwd with a trailing slash', async () => {
    const workspacePath = '/workspace/custom/tool cwd';
    const f = await nativeContainer(name, 'custom', workspacePath, workspacePath + '/');
    try {
      expect(f.backend.workspacePath).toBe(workspacePath + '/');
      expect(f.sandbox.workspacePath).toBe(f.backend.workspacePath);
      const execution = await f.agent.createExecution(f.options);
      expect(await execution.waitForResult()).toMatchObject({ status: 'completed', sessionId: 'native-remote' });
      const direct = await f.post('agent.capture-session', { sandboxId: f.sandbox.id, executionId: execution.id });
      expect(direct.status).toBe(200);
      expect((direct.body as SessionSnapshot).checkpoint).toMatchObject({ worktreePath: f.host, workspacePath });
      const captured = (await execution.captureSession())!;
      expect(captured.checkpoint).toEqual({ version: 1, provider: name, sessionId: 'native-remote', worktreePath: f.host, workspacePath });
      await execution.interrupt('manual');
      await execution.kill();
      const resumed = await f.agent.createExecution({ ...f.options, resume: structuredClone(captured), generation: 2 });
      expect(await resumed.waitForResult()).toMatchObject({ status: 'completed', sessionId: captured.sessionId });
      expect(await resumed.captureSession()).toMatchObject({ generation: 2, checkpoint: { worktreePath: f.host, workspacePath } });
      expect(f.engine.exec).toHaveBeenCalledTimes(2);
      expect(f.engine.exec).toHaveBeenLastCalledWith(expect.objectContaining({ workdir: f.backend.workspacePath }));
      await expect(execution.captureSession()).rejects.toThrow(/superseded/);
    } finally { await f.service.close(); }
  });

  it('rejects a native session reporting a different actual cwd', async () => {
    const f = await nativeContainer(name, 'nested', '/workspace/other-repository');
    try {
      const execution = await f.agent.createExecution(f.options);
      expect(await execution.waitForResult()).toMatchObject({ status: 'failed', error: { code: 'NATIVE_SESSION_MISMATCH' } });
      expect(await execution.captureSession()).toBeUndefined();
      expect(execution.sessionId).toBeUndefined();
    } finally { await f.service.close(); }
  });
});

it('passes Codex exec runtime and the actual native cwd through the real remote container chain', async () => {
  const f = await nativeContainer('codex', 'custom');
  try {
    const runtime = { kind: 'codex' as const, transport: 'exec' as const, auth: 'api' as const,
      provider: 'custom', profile: 'work', startupTimeoutMs: 5000 };
    const execution = await f.agent.createExecution({ ...f.options, runtime });
    expect(await execution.waitForResult()).toMatchObject({ status: 'completed' });
    expect(execution.metadata).toMatchObject({ provider: 'codex', transport: 'exec', auth: 'api', modelProvider: 'custom' });
    expect(f.engine.exec).toHaveBeenCalledWith(expect.objectContaining({ workdir: f.native,
      command: expect.arrayContaining(['codex', 'exec', '--profile', 'work', '--config', 'model_provider="custom"', '-C', f.native]) }));
    const serverStart = f.createExecution.mock.calls.find(([options]) => !options.sandbox.startProviderExecution)![0];
    expect(serverStart).toMatchObject({ worktreePath: f.host, runtime });
    expect(await execution.captureSession()).toBeUndefined();
  } finally { await f.service.close(); }
});

describe('remote container protocol server', () => {
  it('requires explicit opt-in, a strong token and explicitly registered agents', async () => {
    const fixture = await setup();
    expect(() => createRemoteContainerServer({ ...fixture.options, enabled: false })).toThrow(/disabled/);
    expect(() => createRemoteContainerServer({ ...fixture.options, token: '' })).toThrow(/32 bytes/);
    expect(() => createRemoteContainerServer({ ...fixture.options, token: `${token}\n` })).toThrow(/token/);
    expect(() => createRemoteContainerServer({ ...fixture.options, allowedAgents: [] })).toThrow(/allowed agent/);
    expect(() => createRemoteContainerServer({ ...fixture.options, allowedAgents: ['unknown'] })).toThrow(/not registered/);
    expect(await fixture.transport.health!()).toBe(true);
  });

  it('passes validated Codex exec settings to the allowed server provider', async () => {
    const agent = { ...nodeAgent(), name: 'codex' };
    const fixture = await setup({}, agent);
    const created = await fixture.post('sandbox.create', { worktreePath: fixture.root, session: 'runtime-test' });
    const { id: sandboxId } = await created.json() as { id: string };
    const runtime = { kind: 'codex', transport: 'exec', auth: 'api', provider: 'custom', profile: 'work', startupTimeoutMs: 5000 };
    const response = await fixture.post('agent.start', { sandboxId, options: { ...start, metadata: { provider: 'codex', transport: 'exec' }, runtime } });
    expect(response.status).toBe(200);
    expect(agent.createExecution).toHaveBeenCalledWith(expect.objectContaining({ runtime }));
    const { id: executionId } = await response.json() as { id: string };
    await fixture.post('agent.kill', { sandboxId, executionId });
    for (const invalid of [{ ...runtime, transport: 'app-server' }, { ...runtime, endpoint: 'stdio://' }, { ...runtime, startupTimeoutMs: -1 }]) {
      expect((await fixture.post('agent.start', { sandboxId, options: { ...start, metadata: { provider: 'codex', transport: 'exec' }, runtime: invalid } })).status).toBe(400);
    }
    expect((await fixture.post('agent.start', { sandboxId, options: { ...start, runtime } })).status).toBe(400);
    expect(agent.createExecution).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('revokes captured native snapshots when identity fails after interrupt=%s', async interrupted => {
    let invalidated = false;
    let captured!: SessionSnapshot;
    const execution: AgentExecution = {
      id: 'native-first',
      get sessionId() { return invalidated ? undefined : 'native-first'; },
      get metadata() { return { provider: 'cursor', transport: 'process' as const, threadId: invalidated ? undefined : 'native-first' }; },
      waitForEvent: async () => null, captureOutput: async () => '', captureSession: async () => captured,
      interrupt: async () => {}, kill: async () => {}, resume: async () => { throw new Error('old snapshot must not resume'); },
      waitForResult: async () => {
        invalidated = true;
        return { version: 1, runId: 'native-first', provider: 'cursor', status: 'failed', commits: [],
          error: { code: 'NATIVE_SESSION_MISMATCH', message: 'identity changed' } };
      },
    };
    const agent: AgentProvider = { name: 'cursor', capabilities: new Set(['resume']), createExecution: vi.fn(async () => execution), restoreSession: vi.fn(async () => {}) };
    const fixture = await setup({}, agent);
    captured = { sessionId: 'native-first', generation: 0, summary: '', capturedAt: '2026-11-13T00:00:00Z',
      checkpoint: { version: 1, provider: 'cursor', sessionId: 'native-first', worktreePath: fixture.root } };
    const sandbox = await fixture.createSandbox();
    const remote = await sandbox.startAgent({ ...start, metadata: { provider: 'cursor', transport: 'process' } });
    expect(await remote.captureSession()).toEqual(captured);
    if (interrupted) await remote.interrupt('manual');
    expect((await remote.waitForResult()).status).toBe(interrupted ? 'aborted' : 'failed');
    const wait = await fixture.post('agent.wait', { sandboxId: sandbox.id, executionId: remote.id });
    expect((await wait.json() as { sessionInvalidated?: boolean }).sessionInvalidated).toBe(true);
    expect(await remote.captureSession()).toBeUndefined();
    const response = await fixture.post('agent.resume', { sandboxId: sandbox.id, executionId: remote.id, options: { snapshot: captured } });
    expect(response.status).toBe(403);
    expect(agent.createExecution).toHaveBeenCalledTimes(1);
    expect(agent.restoreSession).not.toHaveBeenCalled();
  });

  it('authenticates every route including health and enforces exact methods and route allowlists', async () => {
    const { baseUrl, post } = await setup();
    for (const authorization of ['', 'Bearer wrong-token']) {
      expect((await fetch(`${baseUrl}health`, { headers: { Authorization: authorization } })).status).toBe(401);
    }
    expect((await fetch(`${baseUrl}health`, { headers: { Authorization: `Bearer ${token}`, Origin: 'https://other.example' } })).status).toBe(403);
    expect((await post('health', {})).status).toBe(405);
    expect((await fetch(`${baseUrl}agent.start`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
    for (const operation of ['exec', 'shell', 'agent.start?extra=1', 'agent.start/']) {
      expect((await post(operation, {})).status).toBe(404);
    }
  });

  it('rejects malformed JSON, extra fields, unsupported content types and oversized payloads', async () => {
    const { baseUrl, post } = await setup({ maxBodyBytes: 2048 });
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect((await fetch(`${baseUrl}sandbox.create`, { method: 'POST', headers, body: '{' })).status).toBe(400);
    expect((await post('sandbox.create', { worktreePath: '/', session: 'test', env: { X: 'Y' } })).status).toBe(400);
    expect((await post('workspace.create', { iid: 1, baseBranch: '--upload-pack=bad' })).status).toBe(400);
    expect((await post('sandbox.create', { worktreePath: '/', session: 'test', interactive: true })).status).toBe(400);
    expect((await fetch(`${baseUrl}sandbox.create`, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect((await post('sandbox.create', { large: 'x'.repeat(3000) })).status).toBe(413);
  });

  it('rejects outside paths and symlinks escaping the server workspace root', async () => {
    const { root, directory, post } = await setup();
    const link = join(root, 'escape');
    symlinkSync(directory, link);
    for (const worktreePath of [directory, link, join(root, '..')]) {
      expect((await post('sandbox.create', { worktreePath, session: 'test' })).status).toBe(403);
    }
    expect((await post('sandbox.create', { worktreePath: join(root, 'missing'), session: 'test' })).status).toBe(404);
  });

  it('executes a trusted Node agent through real HTTP and the existing local sandbox registry', async () => {
    const { createSandbox, root, agent } = await setup();
    const sandbox = await createSandbox();
    const execution = await sandbox.startAgent(start);
    const result = await execution.waitForResult({ completionTimeoutMs: 4000 });
    expect(result).toMatchObject({ status: 'completed', provider: 'node-fixture', structuredOutput: { summary: 'trusted node executed' } });
    expect(JSON.parse(readFileSync(join(root, 'executed.json'), 'utf8'))).toEqual({ cwd: root, injected: null });
    expect(agent.createExecution).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: root, executionMode: 'batch' }));
    expect(agent.createExecution).not.toHaveBeenCalledWith(expect.objectContaining({ command: start.command }));
    expect(await execution.captureOutput()).toContain('trusted node executed');
    expect(await execution.captureSession()).toBeUndefined();
    await expect(execution.resume({ snapshot: { sessionId: 'invented', generation: 0, checkpoint: null, summary: '', capturedAt: new Date().toISOString() } })).rejects.toThrow(/409/);
    await sandbox.close();
    await sandbox.close();
  });

  it('surfaces actual process failures through a valid non-success result', async () => {
    const fixture = await setup({}, nodeAgent('console.error("fixture-failed"); process.exit(7)'));
    const execution = await (await fixture.createSandbox()).startAgent(start);
    expect(await execution.waitForResult({ completionTimeoutMs: 4000 })).toMatchObject({ status: 'failed', exitCode: 7 });
    expect(await execution.captureOutput()).toContain('fixture-failed');
  });

  it('propagates provider exceptions without exposing stack traces or private error details', async () => {
    const agent = nodeAgent();
    agent.createExecution = vi.fn(async () => { throw new Error('private-provider-secret'); });
    const { post, createSandbox } = await setup({}, agent);
    const sandbox = await createSandbox();
    const denied = await post('agent.start', { sandboxId: sandbox.id, options: { ...start, metadata: { ...start.metadata, provider: 'unknown' } } });
    expect(denied.status).toBe(403);
    expect(agent.createExecution).not.toHaveBeenCalled();
    const failed = await post('agent.start', { sandboxId: sandbox.id, options: start });
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain('private-provider-secret');
  });

  it.each(['interrupt', 'kill', 'deadline'] as const)('stops real Node processes on %s', async operation => {
    const fixture = await setup({ executionTimeoutMs: operation === 'deadline' ? 300 : 5000 }, nodeAgent('console.log("ready:" + process.pid); setInterval(() => {}, 1000)'));
    const execution = await (await fixture.createSandbox()).startAgent(start);
    await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready'), { timeout: 2000, interval: 10 });
    const pid = Number((await execution.captureOutput()).match(/ready:(\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    if (operation === 'interrupt') await execution.interrupt('manual');
    if (operation === 'kill') await execution.kill();
    expect(await execution.waitForResult({ completionTimeoutMs: 2000 })).toMatchObject({ status: operation === 'deadline' ? 'timed_out' : 'aborted' });
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2000, interval: 10 });
  });

  it('allows explicit cleanup retries after a deadline failure without releasing the active slot early', async () => {
    let failures = 2;
    const kill = vi.fn(async () => {
      if (failures-- > 0) throw new Error('controlled cleanup failure');
    });
    const agent: AgentProvider = {
      name: 'node-fixture', capabilities: new Set(),
      createExecution: async () => ({
        id: 'retry-fixture', metadata: { provider: 'node-fixture', transport: 'process' },
        waitForEvent: async () => null,
        waitForResult: async () => ({ version: 1, runId: 'retry-fixture', status: 'completed', provider: 'node-fixture', commits: [] }),
        captureOutput: async () => '', captureSession: async () => undefined,
        interrupt: async () => {}, kill, resume: async () => { throw new Error('unsupported'); },
      }),
    };
    const fixture = await setup({ executionTimeoutMs: 100 }, agent);
    const sandbox = await fixture.createSandbox();
    const execution = await sandbox.startAgent(start);
    try {
      await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1));
      await expect(sandbox.startAgent(start)).rejects.toThrow(/409/);
      await expect(execution.kill()).rejects.toThrow(/500/);
      expect(kill).toHaveBeenCalledTimes(2);
      await expect(sandbox.startAgent(start)).rejects.toThrow(/409/);
      await execution.kill();
      expect(kill).toHaveBeenCalledTimes(3);
      await expect(execution.captureOutput()).resolves.toBe('');
      await expect(sandbox.startAgent(start)).resolves.toBeDefined();
    } finally { failures = 0; }
  });

  it.each(['stopped', 'terminal'] as const)('ignores late deadline failure after a confirmed %s execution', async state => {
    let rejectDeadline: ((error: Error) => void) | undefined;
    let calls = 0;
    const kill = vi.fn(async () => {
      if (++calls === 1) await new Promise<void>((_resolve, reject) => { rejectDeadline = reject; });
    });
    const agent: AgentProvider = {
      name: 'node-fixture', capabilities: new Set(),
      createExecution: async () => ({
        id: 'late-deadline-fixture', metadata: { provider: 'node-fixture', transport: 'process' },
        waitForEvent: async () => null,
        waitForResult: async () => ({ version: 1, runId: 'late-deadline-fixture', status: 'completed', provider: 'node-fixture', commits: [] }),
        captureOutput: async () => 'owned-output', captureSession: async () => undefined,
        interrupt: async () => {}, kill, resume: async () => { throw new Error('unsupported'); },
      }),
    };
    const fixture = await setup({ executionTimeoutMs: 100 }, agent);
    const sandbox = await fixture.createSandbox();
    const execution = await sandbox.startAgent(start);
    try {
      await vi.waitFor(() => expect(rejectDeadline).toBeDefined());
      await execution.kill();
      if (state === 'terminal') await expect(execution.waitForResult()).resolves.toMatchObject({ status: 'completed' });
      rejectDeadline!(new Error('late deadline stop failed'));
      await new Promise<void>(resolve => setImmediate(resolve));
      await expect(execution.captureOutput()).resolves.toBe('owned-output');
      await execution.kill();
      await expect(execution.captureOutput()).resolves.toBe('owned-output');
      await expect(sandbox.startAgent(start)).resolves.toBeDefined();
    } finally { rejectDeadline?.(new Error('fixture cleanup')); }
  });

  it.each(['kill', 'deadline'] as const)('retains control of a SIGINT-resistant process after its aborted result until %s', async operation => {
    const fixture = await setup({ executionTimeoutMs: operation === 'deadline' ? 1400 : 5000 }, nodeAgent('process.on("SIGINT", () => {}); console.log("ready:" + process.pid); setInterval(() => {}, 1000)'));
    const execution = await (await fixture.createSandbox()).startAgent(start);
    await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready:'), { timeout: 2000, interval: 10 });
    const pid = Number((await execution.captureOutput()).match(/ready:(\d+)/)?.[1]);
    await execution.interrupt('manual');
    expect(await execution.waitForResult({ completionTimeoutMs: 2000 })).toMatchObject({ status: 'aborted' });
    if (operation === 'kill') {
      await execution.kill();
      expect(() => process.kill(pid, 0)).toThrow();
    } else {
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2500, interval: 10 });
    }
  });

  it('rejects a second start while an interrupted process is still alive', async () => {
    const fixture = await setup({}, nodeAgent('process.on("SIGINT", () => {}); console.log("ready:" + process.pid); setInterval(() => {}, 1000)'));
    const sandbox = await fixture.createSandbox();
    const execution = await sandbox.startAgent(start);
    await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready:'), { timeout: 2000, interval: 10 });
    await execution.interrupt('manual');
    expect((await fixture.post('agent.start', { sandboxId: sandbox.id, options: start })).status).toBe(409);
    await execution.kill();
  });

  it('keeps the server deadline active after interrupt without a result request', async () => {
    const fixture = await setup({ executionTimeoutMs: 900 }, nodeAgent('process.on("SIGINT", () => {}); console.log("ready:" + process.pid); setInterval(() => {}, 1000)'));
    const execution = await (await fixture.createSandbox()).startAgent(start);
    await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready:'), { timeout: 2000, interval: 10 });
    const pid = Number((await execution.captureOutput()).match(/ready:(\d+)/)?.[1]);
    await execution.interrupt('manual');
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2500, interval: 10 });
  });

  it('confirms actual process exit before returning a terminal result', async () => {
    const fixture = await setup({}, nodeAgent('console.log("ready:" + process.pid); console.log(JSON.stringify({ type: "result", result: \'<goal_complete>{"type":"goal_complete","summary":"done"}</goal_complete>\' })); setInterval(() => {}, 1000)'));
    const execution = await (await fixture.createSandbox()).startAgent(start);
    await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready:'), { timeout: 2000, interval: 10 });
    const pid = Number((await execution.captureOutput()).match(/ready:(\d+)/)?.[1]);
    expect(await execution.waitForResult()).toMatchObject({ status: 'completed' });
    expect(() => process.kill(pid, 0)).toThrow();
  });

  it('limits sandbox allocation and rejects requests after shutdown', async () => {
    const fixture = await setup({ maxSandboxes: 1 });
    const sandbox = await fixture.createSandbox();
    await expect(fixture.createSandbox()).rejects.toThrow(/429/);
    await sandbox.close();
    await fixture.createSandbox();
    await fixture.service.close();
    expect((await fixture.post('agent.output', {})).status).toBe(503);
  });

  it.each(['kill', 'deadline'] as const)('keeps a context-yielded process subject to %s', async operation => {
    const agent = nodeAgent('console.log("ready:" + process.pid); setInterval(() => {}, 1000)');
    const createExecution = agent.createExecution;
    agent.createExecution = async options => {
      const execution = await createExecution(options);
      return { ...execution, id: execution.id, sessionId: execution.sessionId, metadata: execution.metadata,
        waitForEvent: () => execution.waitForEvent(), captureOutput: capture => execution.captureOutput(capture),
        captureSession: () => execution.captureSession(), interrupt: reason => execution.interrupt(reason),
        kill: () => execution.kill(), resume: resume => execution.resume(resume),
        waitForResult: async () => ({ version: 1, runId: execution.id, provider: agent.name, status: 'context_high', commits: [] }),
      };
    };
    const fixture = await setup({ executionTimeoutMs: operation === 'deadline' ? 900 : 5000 }, agent);
    const sandbox = await fixture.createSandbox();
    const execution = await sandbox.startAgent(start);
    await vi.waitFor(async () => expect(await execution.captureOutput()).toContain('ready:'), { timeout: 2000, interval: 10 });
    const pid = Number((await execution.captureOutput()).match(/ready:(\d+)/)?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect((await execution.waitForResult()).status).toBe('context_high');
    expect(() => process.kill(pid, 0)).not.toThrow();
    if (operation === 'kill') await execution.kill();
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 2500, interval: 10 });
  });

  it('creates a real Git worktree through the workspace endpoint and reuses its registered path', async () => {
    const fixture = await setup();
    execFileSync('git', ['init', '-b', 'main', fixture.directory], { stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: fixture.directory, stdio: 'pipe' });
    const worktree = await fixture.provider.createWorktree({ iid: 123, baseBranch: 'main' });
    expect(worktree.path).toBe(join(fixture.root, 'issue-123'));
    expect(realpathSync(worktree.path)).toBe(worktree.path);
    expect(await fixture.provider.createWorktree({ iid: 123, baseBranch: 'main' })).toEqual(worktree);
    const execution = await (await fixture.provider.create({ worktreePath: worktree.path, session: 'git-test' })).startAgent(start);
    expect(await execution.waitForResult({ completionTimeoutMs: 4000 })).toMatchObject({ status: 'completed' });
  });

  it('waits for an in-flight agent start and kills the late process before shutdown completes', async () => {
    const agent = nodeAgent('console.log("ready:" + process.pid); setInterval(() => {}, 1000)');
    const createExecution = agent.createExecution.bind(agent);
    let release!: () => void;
    let ready!: () => void;
    let output = '';
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { ready = resolve; });
    agent.createExecution = async options => {
      const execution = await createExecution(options);
      await vi.waitFor(async () => { output = await execution.captureOutput(); expect(output).toContain('ready:'); });
      ready();
      await gate;
      return execution;
    };
    const fixture = await setup({}, agent);
    const sandbox = await fixture.createSandbox();
    const pending = expect(sandbox.startAgent(start)).rejects.toThrow(/409/);
    await started;
    let finished = false;
    const closing = fixture.service.close().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    release();
    await Promise.all([pending, closing]);
    const pid = Number(output.match(/ready:(\d+)/)?.[1]);
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow());
  });

  it('allows only captured snapshots, rotates execution IDs on resume and rejects old execution requests', async () => {
    let generation = 0;
    let continuation: string | undefined;
    const captured: SessionSnapshot = { sessionId: 'native-session', generation: 0, checkpoint: { cursor: 'trusted' }, summary: '', capturedAt: new Date().toISOString() };
    const kill = vi.fn(async () => {});
    const makeExecution = (): AgentExecution => ({
      id: `native-${generation++}`, sessionId: captured.sessionId, metadata: start.metadata,
      waitForEvent: async () => null,
      waitForResult: async () => ({ version: 1, runId: 'run', provider: 'node-fixture', status: 'completed', commits: [] }),
      captureOutput: async () => 'resumed', captureSession: async () => captured,
      interrupt: vi.fn(async () => {}), kill, resume: vi.fn(async options => { continuation = options.prompt; return makeExecution(); }),
    });
    const agent: AgentProvider = { name: 'node-fixture', capabilities: new Set(['resume']), createExecution: vi.fn(async () => makeExecution()) };
    const { createSandbox, post } = await setup({}, agent);
    const sandbox = await createSandbox();
    const original = await sandbox.startAgent(start);
    expect(await original.captureSession()).toEqual(captured);
    await original.interrupt('manual');
    expect((await post('agent.resume', { sandboxId: sandbox.id, executionId: original.id, options: { snapshot: { ...captured, checkpoint: { cursor: 'forged' } } } })).status).toBe(403);
    kill.mockRejectedValueOnce(new Error('injected-stop-failure'));
    await expect(original.resume({ snapshot: captured })).rejects.toThrow(/500/);
    expect(generation).toBe(1);
    const resumed = await original.resume({ snapshot: captured, prompt: 'continue the captured fixture' });
    expect(continuation).toBe('continue the captured fixture');
    expect(resumed.id).not.toBe(original.id);
    expect(await resumed.captureOutput()).toBe('resumed');
    expect((await post('agent.output', { sandboxId: sandbox.id, executionId: original.id })).status).toBe(404);
    await expect(original.captureOutput()).rejects.toThrow(/superseded/);
    await sandbox.close();
    expect(kill).toHaveBeenCalledTimes(4);
  });

  it.each([
    { name: 'cursor', create: () => new CursorProvider(), flag: '--resume' },
    { name: 'pi', create: () => new PiProvider(), flag: '--session' },
  ].flatMap(provider => ['direct', 'workflow'].map(mode => ({ ...provider, mode }))))('carries the server-captured $name checkpoint through a real HTTP $mode resume and rejects replacement identities', async ({ name, create, flag, mode }) => {
    const agent = create();
    const buildCommand = agent.buildCommand.bind(agent);
    vi.spyOn(agent, 'buildCommand').mockImplementation(options => {
      const command = buildCommand(options);
      const script = `
        const fs = require('node:fs');
        const { name, flag, argv } = JSON.parse(process.argv[1]);
        const position = argv.indexOf(flag);
        const sessionId = position < 0 ? 'native-http-session' : argv[position + 1];
        fs.appendFileSync('protocol-invocations.jsonl', JSON.stringify({ argv, cwd: process.cwd(), sessionId }) + '\\n');
        const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
        const result = '<goal_complete>{"type":"goal_complete","summary":"protocol fixture"}</goal_complete>';
        if (name === 'cursor') {
          emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });
          emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result });
        } else {
          emit({ type: 'session', version: 3, id: sessionId, cwd: process.cwd() });
          emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: result }], stopReason: 'stop' } });
          emit({ type: 'agent_settled', aborted: false });
        }
      `;
      return { ...command, argv: [process.execPath, '-e', script, JSON.stringify({ name, flag, argv: command.argv })] };
    });
    const createExecution = vi.spyOn(agent, 'createExecution');
    const restoreSession = vi.spyOn(agent, 'restoreSession');
    const { createSandbox, root, post } = await setup({}, agent);
    const sandbox = await createSandbox();
    const original = await sandbox.startAgent({ ...start, metadata: { provider: name, transport: 'process', threadId: 'untrusted-start-identity' } });
    expect(await original.waitForResult({ completionTimeoutMs: 4000 })).toMatchObject({ status: 'completed', sessionId: 'native-http-session' });
    const captured = (await original.captureSession())!;
    expect(captured).toMatchObject({ sessionId: 'native-http-session', generation: 0,
      checkpoint: { version: 1, provider: name, sessionId: 'native-http-session', worktreePath: root } });
    const request = { sandboxId: sandbox.id, executionId: original.id };
    for (const replacement of [
      { ...captured, sessionId: 'untrusted-session' },
      { ...captured, generation: 99 },
      { ...captured, checkpoint: { ...captured.checkpoint as object, provider: 'untrusted-provider' } },
      { ...captured, checkpoint: { ...captured.checkpoint as object, worktreePath: '/' } },
    ]) {
      expect((await post('agent.resume', { ...request, options: { snapshot: replacement } })).status).toBe(403);
    }
    expect((await post('agent.resume', { ...request, options: { snapshot: captured, sessionId: 'untrusted-session' } })).status).toBe(400);
    expect((await post('agent.resume', { ...request, worktreePath: '/', options: { snapshot: captured } })).status).toBe(400);
    expect(createExecution).toHaveBeenCalledOnce();
    expect(restoreSession).not.toHaveBeenCalled();
    const resumed = mode === 'direct' ? await original.resume({ snapshot: captured })
      : await attemptNativeResume({ iid: 42, session: 'new-logical-session', wtPath: root, runId: 'fixture', generation: 1,
        signalType: 'goal_complete', prompt: 'continued workflow prompt', executionMode: 'batch' }, create(), sandbox,
      () => ({ loadFirst: async () => ({ snapshot: captured, storeName: 'fixture' }) }) as never, async () => {});
    expect(resumed).toBeDefined();
    expect(await resumed!.waitForResult({ completionTimeoutMs: 4000 })).toMatchObject({ status: 'completed', provider: name, sessionId: 'native-http-session' });
    expect(createExecution).toHaveBeenCalledTimes(2);
    expect(createExecution.mock.calls[1][0]).toMatchObject({ resume: captured, sessionId: captured.sessionId,
      generation: 1, worktreePath: root, executionMode: 'batch' });
    if (mode === 'workflow') expect(createExecution.mock.calls[1][0].prompt).toBe('continued workflow prompt');
    const invocations = readFileSync(join(root, 'protocol-invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(invocations).toHaveLength(2);
    expect(invocations[0].argv).not.toContain(flag);
    expect(invocations[1]).toMatchObject({ cwd: root, sessionId: captured.sessionId });
    expect(invocations[1].argv.slice(-2)).toEqual([flag, captured.sessionId]);
    expect((await post('agent.output', request)).status).toBe(404);
    await sandbox.close();
  });
});
