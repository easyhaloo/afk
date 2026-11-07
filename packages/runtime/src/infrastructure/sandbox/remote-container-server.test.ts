import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProviderRegistry } from '../../domain/agents/registry.js';
import type { AgentExecution, AgentProvider, AgentStartOptions, SessionSnapshot } from '../../domain/agents/types.js';
import { WorktreeManager } from '../git/index.js';
import { SandboxProviderRegistry } from './registry.js';
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

  it('limits sandbox allocation and rejects requests after shutdown', async () => {
    const fixture = await setup({ maxSandboxes: 1 });
    const sandbox = await fixture.createSandbox();
    await expect(fixture.createSandbox()).rejects.toThrow(/429/);
    await sandbox.close();
    await fixture.createSandbox();
    await fixture.service.close();
    expect((await fixture.post('agent.output', {})).status).toBe(503);
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
    const captured: SessionSnapshot = { sessionId: 'native-session', generation: 0, checkpoint: { cursor: 'trusted' }, summary: '', capturedAt: new Date().toISOString() };
    const kill = vi.fn(async () => {});
    const makeExecution = (): AgentExecution => ({
      id: `native-${generation++}`, sessionId: captured.sessionId, metadata: start.metadata,
      waitForEvent: async () => null,
      waitForResult: async () => ({ version: 1, runId: 'run', provider: 'node-fixture', status: 'completed', commits: [] }),
      captureOutput: async () => 'resumed', captureSession: async () => captured,
      interrupt: vi.fn(async () => {}), kill, resume: vi.fn(async () => makeExecution()),
    });
    const agent: AgentProvider = { name: 'node-fixture', capabilities: new Set(['resume']), createExecution: vi.fn(async () => makeExecution()) };
    const { createSandbox, post } = await setup({}, agent);
    const sandbox = await createSandbox();
    const original = await sandbox.startAgent(start);
    expect(await original.captureSession()).toEqual(captured);
    await original.interrupt('manual');
    expect((await post('agent.resume', { sandboxId: sandbox.id, executionId: original.id, options: { snapshot: { ...captured, checkpoint: { cursor: 'forged' } } } })).status).toBe(403);
    const resumed = await original.resume({ snapshot: captured });
    expect(resumed.id).not.toBe(original.id);
    expect(await resumed.captureOutput()).toBe('resumed');
    expect((await post('agent.output', { sandboxId: sandbox.id, executionId: original.id })).status).toBe(404);
    await expect(original.captureOutput()).rejects.toThrow(/superseded/);
    await sandbox.close();
    expect(kill).toHaveBeenCalledTimes(2);
  });
});
