import { chmod, lstat, mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultPluginRuntime, type DefaultPluginRuntimeOptions } from './default-runtime.js';
import { LifecycleDispatcher, type LifecycleContext } from '../workflows/lifecycle.js';
import type { PluginRuntime } from './runtime.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';
import { GitPushTriggerProvider, IssueEventTriggerProvider } from '../../infrastructure/providers/triggers.js';
import { startPluginListener, pluginTriggerQueue } from './listener.js';
import { createPluginRunObserver } from './observability.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { createLocalEncryptedEvidenceStore } from '../../infrastructure/observability/local-evidence-store.js';
import type { RunEvent } from '@afk/core';
import { simpleGit } from 'simple-git';
import { withObservationSignal } from '../../observability/run-observer.js';
import type { EvidenceStoreProvider } from '../../plugin-sdk/capabilities.js';

vi.mock('../workflows/execute-work-item.js', () => ({ executeWorkItem: vi.fn() }));

const directories: string[] = [];
const runtimes: PluginRuntime[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()));
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture(configuration?: unknown, options: DefaultPluginRuntimeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'default-plugins-'));
  directories.push(root);
  const homeDir = join(root, 'home');
  const workspaceRoot = join(root, 'workspace');
  await mkdir(join(homeDir, '.afk'), { recursive: true });
  await mkdir(workspaceRoot);
  if (configuration !== undefined) await writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify(configuration));
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot, ...options });
  runtimes.push(runtime);
  const context: LifecycleContext = { iid: 42, worktreePath: workspaceRoot, baseBranch: 'main', sessionName: 'test-42', params: {} };
  return { runtime, context, homeDir, workspaceRoot, lifecycle: new LifecycleDispatcher(runtime.getLifecycleModules()) };
}

async function verificationContext(runtime: PluginRuntime, context: LifecycleContext, homeDir: string) {
  const git = simpleGit(context.worktreePath);
  await git.init().addConfig('user.name', 'Verification test').addConfig('user.email', 'verification@example.test');
  await git.commit('Initial verification revision', { '--allow-empty': null });
  const events = new JsonlEventStore({ root: join(homeDir, 'verification-events') });
  const observer = createPluginRunObserver(runtime, events.root);
  const identity = { traceId: 'verification-trace', runId: 'verification-run', workItemId: 'github:acme/api#42',
    profileId: 'test', attempt: 1, actor: { kind: 'system' as const, id: 'verification-test' } };
  const observed: LifecycleContext = { ...context,
    observation: { context: identity, record: (data, options) => observer.record(identity, data, options) } };
  return { context: observed, events, revision: await git.revparse(['HEAD']) };
}

async function installedCredentialFixture(plugins: unknown[], requires = ['context.provider'], fail = false) {
  const { homeDir, workspaceRoot } = await fixture();
  const directory = join(homeDir, '.afk', 'plugins', 'credential.fixture', 'dist');
  await mkdir(directory, { recursive: true });
  const entry = join(directory, 'index.js');
  await writeFile(entry, `export let resolutions = 0;
    export default {
      manifest: { id: 'credential.fixture', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], requires: ${JSON.stringify(requires)}, trusted: true },
      activate(context) {
        context.registerCredentialProvider('fixture', {
          id: 'fixture', capabilities: { read: true, rotate: false, 'scoped-token': false },
          async resolve() { resolutions++; ${fail ? "throw new Error('synthetic resolution failure');" : "return { secret: 'https://webhook.example.test/fixture' };"} }
        });
      }
    };`);
  await writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'credential.fixture' }, ...plugins] }));
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
  runtimes.push(runtime);
  return { runtime, credential: await import(pathToFileURL(entry).href) };
}

async function installedEvidenceFixture(selection: unknown, artifacts = false, disabled = false) {
  const { homeDir, workspaceRoot } = await fixture();
  const directory = join(homeDir, '.afk', 'plugins', 'evidence.fixture', 'dist');
  const remote = join(workspaceRoot, 'evidence-mirror');
  const events = join(workspaceRoot, 'events');
  await mkdir(directory, { recursive: true });
  await mkdir(remote);
  const entry = join(directory, 'index.js');
  await writeFile(entry, `import { readFile, writeFile, readdir } from 'node:fs/promises';
    import { join } from 'node:path';
    export const calls = [];
    const records = new Map();
    export default {
      manifest: { id: 'evidence.fixture', version: '1.0.0', apiVersion: 1, provides: ['observe.evidence'], trusted: true },
      activate(context) {
        context.registerCapability('observe.evidence', 'private', {
          id: 'private', capabilities: { put: true, get: true, classify: false },
          async put(record, operation) {
            operation.signal.throwIfAborted();
            const source = JSON.parse(Buffer.from(record.bytes).toString());
            const history = (await Promise.all((await readdir(${JSON.stringify(events)})).filter(name => name.endsWith('.jsonl'))
              .map(name => readFile(join(${JSON.stringify(events)}, name), 'utf8')))).join('\\n');
            if (!history.split('\\n').filter(Boolean).some(line => JSON.parse(line).id === source.sourceEventId)) throw new Error('source not durable');
            const { bytes, ...metadata } = record;
            records.set(record.id, metadata);
            await writeFile(join(${JSON.stringify(remote)}, record.id), bytes);
            calls.push({ operation: 'put', id: record.id });
            return { name: record.id, uri: 'file://' + join(${JSON.stringify(remote)}, record.id) };
          },
          async get(id, operation) {
            operation.signal.throwIfAborted();
            calls.push({ operation: 'get', id });
            return { ...records.get(id), bytes: await readFile(join(${JSON.stringify(remote)}, id)) };
          }
        });
      }
    };`);
  await writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({
    plugins: [{ id: 'evidence.fixture', enabled: !disabled }],
    ...(selection === undefined ? {} : { evidenceStore: selection }),
    ...(artifacts ? { integrations: { evidence: { provider: 'test-report-local' } } } : {}),
  }));
  const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
  runtimes.push(runtime);
  const plugin = await import(pathToFileURL(entry).href);
  const context = { traceId: 'evidence-trace', runId: 'evidence-run', workItemId: 'github:org/repo#1', profileId: 'test', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
  return { homeDir, workspaceRoot, events, remote, runtime, plugin, context };
}

it('selects an installed SDK EvidenceStore from saved configuration without an ArtifactSink selection', async () => {
  const { homeDir, events, remote, runtime, plugin, context } = await installedEvidenceFixture({ provider: 'private', scopes: ['github:org/repo'] });
  await expect(lstat(join(homeDir, '.afk', 'evidence'))).rejects.toMatchObject({ code: 'ENOENT' });
  await createPluginRunObserver(runtime, events).record(context, { kind: 'qa.failed', summary: 'password=configuration-private' });
  expect(plugin.calls.map((call: { operation: string }) => call.operation)).toEqual(['put', 'get']);
  const mirrored = await readFile(join(remote, plugin.calls[0].id));
  expect(mirrored.toString()).not.toContain('configuration-private');
  const audit = new JsonlEventStore({ root: events });
  const history = [];
  for await (const event of audit.read(context.runId)) history.push(event);
  const ref = history[0].evidence![0];
  expect(await (await createLocalEncryptedEvidenceStore(homeDir)).get(ref)).toEqual(mirrored);
  expect(history[1].data).toMatchObject({ effectKind: 'evidence.mirror', outcome: 'succeeded' });
  expect(await audit.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
});

it('keeps a pre-cancelled saved EvidenceStore selection local without contaminating the next run', async () => {
  const { runtime, context, events, plugin } = await installedEvidenceFixture({ provider: 'private', scopes: ['github:org/repo'] });
  const observer = createPluginRunObserver(runtime, events);
  const cancelled = new AbortController();
  cancelled.abort(new Error('cancelled before audit'));
  await withObservationSignal(cancelled.signal, () => observer.record(context, { kind: 'qa.failed' }));
  expect(plugin.calls).toEqual([]);
  const store = new JsonlEventStore({ root: events });
  const history: RunEvent[] = [];
  for await (const event of store.read(context.runId)) history.push(event);
  expect(history[0].data.kind).toBe('qa.failed');
  expect(history[1].data).toMatchObject({ effectKind: 'evidence.mirror', outcome: 'failed', summary: expect.stringContaining('cancelled') });
  expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
  await observer.record({ ...context, runId: 'evidence-next-run' }, { kind: 'qa.passed' });
  expect(plugin.calls.map((call: { operation: string }) => call.operation)).toEqual(['put', 'get']);
});

it('isolates concurrent run cancellation with one saved EvidenceStore and rejects late readback', async () => {
  const { runtime, context, events, plugin } = await installedEvidenceFixture({ provider: 'private', scopes: ['github:org/repo'], timeoutMs: 60_000 });
  const provider = runtime.getProvider<EvidenceStoreProvider>('observe.evidence', 'private')!;
  const originalPut = provider.put.bind(provider);
  let enter!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>(resolve => { enter = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const put = vi.spyOn(provider, 'put').mockImplementationOnce(async (record, operation) => {
    enter(operation!.signal! as AbortSignal);
    await gate;
    try { return await originalPut(record, { signal: new AbortController().signal }); }
    finally { finish(); }
  });
  const readback = vi.spyOn(provider, 'get');
  const first = new AbortController();
  const second = new AbortController();
  const observerA = createPluginRunObserver(runtime, events);
  const observerB = createPluginRunObserver(runtime, events);
  const pending = withObservationSignal(first.signal, () => observerA.record(context, { kind: 'qa.failed' }));
  try {
    const signal = await entered;
    await withObservationSignal(second.signal, () => observerB.record({ ...context, runId: 'evidence-other-run' }, { kind: 'qa.passed' }));
    first.abort(new Error('only first run cancelled'));
    await pending;
    expect(signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    release();
    await finished;
    expect(put).toHaveBeenCalledTimes(2);
    expect(readback).toHaveBeenCalledTimes(1);
    expect(plugin.calls.map((call: { operation: string }) => call.operation)).toEqual(['put', 'get', 'put']);
    const store = new JsonlEventStore({ root: events });
    const history: RunEvent[] = [];
    for await (const event of store.read(context.runId)) history.push(event);
    expect(history[1].data).toMatchObject({ effectKind: 'evidence.mirror', outcome: 'failed', summary: expect.stringContaining('cancelled') });
    expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
    expect(await store.verify('evidence-other-run')).toMatchObject({ valid: true, lastSequence: 2 });
  } finally { first.abort(); release(); await pending; }
});

it('keeps registered but unselected SDK stores private and preserves ArtifactSink evidence configuration', async () => {
  const unselected = await installedEvidenceFixture(undefined);
  await createPluginRunObserver(unselected.runtime, unselected.events).record(unselected.context, { kind: 'qa.passed' });
  expect(unselected.plugin.calls).toEqual([]);
  expect(await readdir(unselected.remote)).toEqual([]);
  await expect(lstat(join(unselected.homeDir, '.afk', 'evidence'))).rejects.toMatchObject({ code: 'ENOENT' });
  const selected = await installedEvidenceFixture({ provider: 'private', scopes: ['github:org/repo'] }, true);
  await createPluginRunObserver(selected.runtime, selected.events).record(selected.context, { kind: 'qa.passed' });
  expect(selected.plugin.calls.map((call: { operation: string }) => call.operation)).toEqual(['put', 'get']);
  const history = [];
  for await (const event of new JsonlEventStore({ root: selected.events }).read(selected.context.runId)) history.push(event);
  expect(history[0].evidence).toHaveLength(1);
  expect(history.filter(event => event.data.kind === 'effect.completed').map(event => event.data)).toEqual([
    expect.objectContaining({ effectKind: 'artifact.upload', outcome: 'succeeded' }),
    expect.objectContaining({ effectKind: 'evidence.mirror', outcome: 'succeeded' }),
  ]);
});

it.each([false, true])('blocks an unavailable saved EvidenceStore selection with disabled=%s', async disabled => {
  const { runtime, homeDir, workspaceRoot } = await installedEvidenceFixture({ provider: disabled ? 'private' : 'missing-private', scopes: ['github:org/repo'] }, false, disabled);
  const lifecycle = new LifecycleDispatcher(runtime.getLifecycleModules());
  expect(await runtime.diagnostics()).toContainEqual(expect.objectContaining({ code: 'config.evidence-store-invalid' }));
  await expect(lifecycle.run('init', { iid: 1, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot })).rejects.toThrow('Evidence store selection is unavailable');
  await expect(lstat(join(homeDir, '.afk', 'evidence'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('reports one safe runtime diagnostic for repeated SDK failures while preserving local evidence', async () => {
  const { runtime, events, context } = await installedEvidenceFixture({ provider: 'private', scopes: ['github:org/repo'] });
  const provider = runtime.getProvider<import('../../plugin-sdk/capabilities.js').EvidenceStoreProvider>('observe.evidence', 'private')!;
  provider.put = async () => { throw new Error('token=private-provider-error'); };
  const observer = createPluginRunObserver(runtime, events);
  await observer.record(context, { kind: 'qa.passed' });
  await observer.record(context, { kind: 'qa.passed' });
  const diagnostics = await runtime.diagnostics();
  expect(diagnostics.filter(entry => entry.code === 'evidence.mirror-failed')).toHaveLength(1);
  expect(JSON.stringify(diagnostics)).not.toContain('private-provider-error');
  const history: RunEvent[] = [];
  for await (const event of new JsonlEventStore({ root: events }).read(context.runId)) history.push(event);
  expect(history.filter(event => event.data.kind === 'qa.passed').every(event => event.evidence?.[0]?.uri.startsWith('evidence://'))).toBe(true);
  expect(history.filter(event => event.data.kind === 'effect.completed').map(event => event.data)).toEqual([
    expect.objectContaining({ effectKind: 'evidence.mirror', outcome: 'failed' }),
    expect.objectContaining({ effectKind: 'evidence.mirror', outcome: 'failed' }),
  ]);
  expect(JSON.stringify(history)).not.toContain('private-provider-error');
});

it.each([
  null, {}, { provider: 'private' }, { provider: 'private', scopes: [] },
  { provider: 'private', scopes: ['github:org/repo', 'github:org/repo'] },
  { provider: 'private', scopes: ['*'] }, { provider: 'private', scopes: ['github:org/repo#1'] },
  { provider: 'private', scopes: ['github:org/repo'], maxBytes: 1024 * 1024 + 1 },
  { provider: 'private', scopes: ['github:org/repo'], timeoutMs: 0 },
  { provider: 'private', scopes: ['github:org/repo'], unknown: 'private-config-value' },
])('rejects invalid explicit EvidenceStore selection without revealing configuration %#', async selection => {
  const { runtime, context, lifecycle, homeDir } = await fixture({ evidenceStore: selection });
  expect(await runtime.diagnostics()).toContainEqual(expect.objectContaining({ code: 'config.evidence-store-invalid' }));
  expect(JSON.stringify(await runtime.diagnostics())).not.toContain('private-config-value');
  await expect(lifecycle.run('init', { iid: context.iid, projectName: undefined, baseBranch: context.baseBranch, params: {}, originalCwd: context.worktreePath })).rejects.toThrow('Evidence store selection');
  await expect(lstat(join(homeDir, '.afk', 'evidence'))).rejects.toMatchObject({ code: 'ENOENT' });
});

describe('createDefaultPluginRuntime', () => {
  it('keeps inventory and artifact diagnostics read-only when the home does not exist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'default-plugins-readonly-'));
    directories.push(root);
    const homeDir = join(root, 'missing-home');
    const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: root });
    runtimes.push(runtime);
    expect(runtime.listPlugins()).toContain('artifact.test-report-local');
    expect(await runtime.health('artifact.test-report-local')).toEqual([
      expect.objectContaining({ pluginId: 'artifact.test-report-local', status: 'degraded' }),
    ]);
    expect(await runtime.diagnostics('artifact.test-report-local')).toEqual([]);
    await expect(lstat(homeDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not initialize selected audit storage during inventory or health with a read-only home', async () => {
    const { homeDir, workspaceRoot } = await fixture();
    const root = join(homeDir, '.afk');
    await writeFile(join(root, 'plugins.yml'), JSON.stringify({
      plugins: [{ id: 'artifact.test-report-local', builtin: true, config: { root: join(root, 'reports') } }],
      integrations: { evidence: { provider: 'test-report-local' } },
    }));
    const before = await readdir(homeDir, { recursive: true });
    await chmod(root, 0o500);
    await chmod(homeDir, 0o500);
    try {
      const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
      runtimes.push(runtime);
      expect(runtime.listPlugins()).toContain('artifact.test-report-local');
      expect(await runtime.health('artifact.test-report-local')).toEqual([
        expect.objectContaining({ status: 'degraded' }),
      ]);
      expect((await runtime.diagnostics()).filter(diagnostic => diagnostic.severity === 'error')).toEqual([]);
      expect(await readdir(homeDir, { recursive: true })).toEqual(before);
      expect((await lstat(root)).mode & 0o777).toBe(0o500);
      expect((await lstat(homeDir)).mode & 0o777).toBe(0o500);
    } finally {
      await chmod(homeDir, 0o700);
      await chmod(root, 0o700);
    }
  });

  it('initializes private audit storage only on controlled workflow init and reuses its key after restart', async () => {
    const { runtime, homeDir, workspaceRoot, lifecycle } = await fixture({ integrations: { evidence: { provider: 'test-report-local' } } });
    const evidenceRoot = join(homeDir, '.afk', 'evidence');
    await expect(lstat(evidenceRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot });
    const key = await readFile(join(evidenceRoot, 'encryption.key'));
    expect(key).toHaveLength(32);
    expect((await lstat(evidenceRoot)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(evidenceRoot, 'encryption.key'))).mode & 0o777).toBe(0o600);
    const restarted = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
    runtimes.push(restarted);
    const context = { traceId: 'lazy-evidence', runId: 'lazy-evidence', workItemId: 'github:acme/api#42', profileId: 'local', attempt: 1, actor: { kind: 'system' as const, id: 'test' } };
    await Promise.all([runtime, restarted].map((current, index) => createPluginRunObserver(current, join(workspaceRoot, 'audit')).record(
      { ...context, runId: `${context.runId}-${index}` }, { kind: 'qa.passed' },
    )));
    expect(await readFile(join(evidenceRoot, 'encryption.key'))).toEqual(key);
    const evidence = await createLocalEncryptedEvidenceStore(homeDir);
    for (const index of [0, 1]) {
      const store = new JsonlEventStore({ root: join(workspaceRoot, 'audit') });
      const events: RunEvent[] = [];
      for await (const event of store.read(`${context.runId}-${index}`)) events.push(event);
      expect(events[0].evidence).toHaveLength(1);
      expect(events[1].data).toMatchObject({ kind: 'effect.completed', outcome: 'succeeded' });
      expect(JSON.parse(Buffer.from(await evidence.get(events[0].evidence![0])).toString('utf8'))).toMatchObject({ kind: 'qa.passed' });
      expect(await store.verify(`${context.runId}-${index}`)).toMatchObject({ valid: true, lastSequence: 2 });
    }
  });

  it('blocks controlled workflow init with a safe error when lazy audit storage cannot initialize', async () => {
    const { runtime, homeDir, workspaceRoot, lifecycle } = await fixture({ integrations: { evidence: { provider: 'test-report-local' } } });
    const evidenceRoot = join(homeDir, '.afk', 'evidence');
    await rm(evidenceRoot, { recursive: true, force: true });
    await writeFile(evidenceRoot, 'secret=private-storage-detail');
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot }))
      .rejects.toThrow('Audit evidence storage could not be initialized');
    const diagnostics = await runtime.diagnostics();
    expect(diagnostics).toContainEqual(expect.objectContaining({ code: 'config.evidence-invalid', severity: 'error' }));
    expect(JSON.stringify(diagnostics)).not.toMatch(/private-storage-detail|secret=|ENOTDIR/);
    expect(JSON.stringify(diagnostics)).not.toContain(homeDir);
    expect(await readFile(evidenceRoot, 'utf8')).toBe('secret=private-storage-detail');
  });

  it('captures and exports evidence through the configured default runtime and keeps the key across restarts', async () => {
    const { runtime, homeDir, workspaceRoot } = await fixture({ integrations: { evidence: { provider: 'test-report-local', timeoutMs: 1000 } } });
    const root = join(workspaceRoot, 'audit');
    const context = { traceId: 'trace', runId: 'evidence-run', workItemId: 'github:acme/api#42', profileId: 'local', attempt: 1, actor: { kind: 'cli' as const, id: 'test' } };
    await createPluginRunObserver(runtime, root).record(context, { kind: 'qa.passed' });
    const events: RunEvent[] = [];
    const store = new JsonlEventStore({ root });
    for await (const event of store.read(context.runId)) events.push(event);
    expect(events).toHaveLength(2);
    expect(events[0].evidence).toHaveLength(1);
    expect(events[1].data).toMatchObject({ kind: 'effect.completed', effectKind: 'artifact.upload', outcome: 'succeeded' });
    const evidence = await createLocalEncryptedEvidenceStore(homeDir);
    expect(JSON.parse(Buffer.from(await evidence.get(events[0].evidence![0])).toString('utf8'))).toMatchObject({ kind: 'qa.passed' });
    expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 2 });
  });

  it('blocks configured audit capture when its artifact provider cannot write', async () => {
    const { runtime, lifecycle } = await fixture({ integrations: { evidence: { provider: 'missing-artifacts' } } });
    expect(await runtime.diagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'config.evidence-invalid' })]));
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: '/' })).rejects.toThrow('Audit evidence');
  });

  it('propagates durable delivery identity to managed execution and deduplicates HTTP redelivery', async () => {
    vi.mocked(executeWorkItem).mockResolvedValue({ status: 'done' } as Awaited<ReturnType<typeof executeWorkItem>>);
    const { runtime, homeDir } = await fixture({ plugins: [
      { id: 'trigger.git-push', builtin: true, action: 'work-item.execute', config: { triggers: [{ id: 'push', kind: 'webhook', input: { workItemId: 'github:acme/api#42' } }] } },
    ] }, { activateTriggers: true });
    const listener = await startPluginListener(runtime, { token: 'synthetic-listener-token', port: 0, queuePath: join(homeDir, '.afk', 'triggers', 'deliveries.sqlite') });
    try {
      const address = listener.address;
      if (!address || typeof address === 'string') throw new Error('Missing listener address');
      const send = () => fetch(`http://127.0.0.1:${address.port}/triggers/trigger.git-push`, { method: 'POST', headers: { authorization: 'Bearer synthetic-listener-token', 'x-github-delivery': 'stable-delivery' }, body: JSON.stringify({ ref: 'refs/heads/main' }) });
      const receipt = await (await send()).json() as { deliveryId: string };
      await vi.waitFor(() => expect(listener.queue!.status(receipt.deliveryId)[0].status).toBe('delivered'));
      expect(vi.mocked(executeWorkItem).mock.calls.at(-1)?.[0]).toMatchObject({ workItemId: 'github:acme/api#42', executionId: createHash('sha256').update(`${receipt.deliveryId}\0github:acme/api#42`).digest('hex') });
      const before = vi.mocked(executeWorkItem).mock.calls.length;
      expect((await send()).status).toBe(202);
      expect(vi.mocked(executeWorkItem).mock.calls).toHaveLength(before);
    } finally { await listener.close(); }
  });
  it.each(['missing', 'disabled', 'enabled'])('loads Gmail only with its enabled exact Google credential dependency (%s)', async state => {
    const { GoogleOAuthCredentialProvider } = await import('../../infrastructure/providers/google-oauth.js');
    const account = vi.spyOn(GoogleOAuthCredentialProvider.prototype, 'resolveAccount').mockRejectedValue(new Error('must not authenticate'));
    const network = vi.fn();
    vi.stubGlobal('fetch', network);
    try {
      const { runtime } = await fixture({ plugins: [
        { id: 'notification.gmail', builtin: true, config: {} },
        ...state === 'missing' ? [] : [{ id: 'credential.google-oauth', builtin: true, enabled: state === 'enabled', config: {} }],
      ] });
      expect(runtime.getCredentialProvider('credential.system-keychain')).toBeDefined();
      const findings = (await runtime.diagnostics()).filter(item => item.pluginId === 'notification.gmail');
      if (state === 'enabled') {
        expect(runtime.getNotificationProvider('notification.gmail')).toBeDefined();
        expect(findings.filter(item => item.severity === 'error')).toEqual([]);
      } else {
        expect(runtime.getNotificationProvider('notification.gmail')).toBeUndefined();
        expect(findings).toContainEqual(expect.objectContaining({ code: 'load.dependencies' }));
      }
      expect(account).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    } finally { account.mockRestore(); }
  });

  it.each([false, true])('waits for an installed named credential provider across builtin activation (nested: %s)', async nested => {
    const network = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', network);
    const { runtime, credential } = await installedCredentialFixture([
      { id: 'notification.slack', builtin: true, config: { webhook: { provider: nested ? 'credential.enterprise' : 'fixture', name: 'webhook' } } },
      ...nested ? [{ id: 'credential.enterprise', builtin: true, config: { values: { webhook: { provider: 'fixture', name: 'webhook' } } } }] : [],
    ]);
    expect(runtime.getCredentialProvider('credential.system-keychain')).toBeDefined();
    expect(runtime.getCredentialProvider('fixture')).toBeDefined();
    expect(runtime.getNotificationProvider('notification.slack')).toBeDefined();
    expect(credential.resolutions).toBe(0);
    expect((await runtime.diagnostics()).filter(item => item.severity === 'error')).toEqual([]);
    expect(network).not.toHaveBeenCalled();
    await expect(runtime.getNotificationProvider('notification.slack')!.notify({ title: 'Build', body: 'Delivery' })).resolves.toMatchObject({ delivered: true });
    expect(credential.resolutions).toBe(1);
    expect(network).toHaveBeenCalledOnce();
  });

  it.each([false, true])('reports unresolved named credential dependencies without attempting activation (cycle: %s)', async cycle => {
    const { runtime, credential } = await installedCredentialFixture([
      { id: 'tracker.linear', builtin: true, config: { baseUrl: 'https://linear.example.test', teamId: 'team', token: { provider: cycle ? 'fixture' : 'missing', name: 'api' } } },
    ], cycle ? ['tracker.issue'] : ['context.provider']);
    expect(runtime.getCredentialProvider('credential.system-keychain')).toBeDefined();
    expect(runtime.getIssueTrackerProvider('linear')).toBeUndefined();
    expect(credential.resolutions).toBe(0);
    const errors = (await runtime.diagnostics()).filter(item => item.pluginId === 'tracker.linear');
    expect(errors.map(item => item.code)).toEqual(['load.dependencies']);
    if (cycle) expect(await runtime.diagnostics()).toContainEqual(expect.objectContaining({ pluginId: 'credential.fixture', code: 'load.dependencies' }));
  });

  it('does not retry a named provider resolution that fails at delivery', async () => {
    const network = vi.fn(); vi.stubGlobal('fetch', network);
    const { runtime, credential } = await installedCredentialFixture([
      { id: 'notification.slack', builtin: true, config: { webhook: { provider: 'fixture', name: 'webhook' } } },
    ], ['context.provider'], true);
    expect(runtime.getCredentialProvider('fixture')).toBeDefined();
    expect(runtime.getNotificationProvider('notification.slack')).toBeDefined();
    expect(credential.resolutions).toBe(0);
    const errors = (await runtime.diagnostics()).filter(item => item.pluginId === 'notification.slack');
    expect(errors).toEqual([]);
    await expect(runtime.getNotificationProvider('notification.slack')!.notify({ title: 'Build', body: 'Delivery' })).resolves.toMatchObject({ delivered: false, error: 'Operation credential unavailable' });
    expect(credential.resolutions).toBe(1);
    expect(network).not.toHaveBeenCalled();
  });

  it('activates configured credential references before their consumers regardless of input order', async () => {
    vi.stubEnv('PLUGIN_E2E_WEBHOOK', 'https://webhook.example.test/fixture');
    const { runtime } = await fixture({ plugins: [
      { id: 'notification.slack', builtin: true, config: { webhook: { provider: 'credential.enterprise', name: 'webhook' } } },
      { id: 'credential.enterprise', builtin: true, config: { values: { webhook: { env: 'PLUGIN_E2E_WEBHOOK' } } } },
    ] });
    expect(runtime.getNotificationProvider('notification.slack')).toBeDefined();
    expect((await runtime.diagnostics()).filter(item => item.severity === 'error')).toEqual([]);
  });

  it('routes batched configured triggers using each originating plugin action', async () => {
    const { runtime } = await fixture({ plugins: [
      { id: 'trigger.git-push', builtin: true, action: 'work-item.execute', config: { triggers: [{ id: 'push', kind: 'webhook', input: { workItemId: 'github:acme/api#42' } }] } },
      { id: 'trigger.issue-event', builtin: true, action: 'capability.invoke', config: { triggers: [{ id: 'issue', kind: 'webhook', input: { capability: 'policy.provider', provider: 'compliance-policy', operation: 'evaluate', input: { action: 'inspect' } } }] } },
    ] }, { activateTriggers: true });
    const dispatch = vi.spyOn(runtime, 'dispatchSystemAction').mockResolvedValue(undefined);
    await (runtime.getTriggerProvider('trigger.git-push') as GitPushTriggerProvider).handlePush({ ref: 'refs/heads/main' });
    await (runtime.getTriggerProvider('trigger.issue-event') as IssueEventTriggerProvider).handleIssue({ action: 'opened' });
    expect(dispatch.mock.calls.map(([action]) => action)).toEqual(['work-item.execute', 'capability.invoke']);
  });

  it('honors disabled builtin entries without requiring a configuration object', async () => {
    const { runtime } = await fixture({ plugins: [{ id: 'context.code', builtin: true, enabled: false }] });
    expect(runtime.getContextProvider('context.code')).toBeUndefined();
    expect(runtime.getContextProvider('context.retrieval')).toBeDefined();
  });

  it('lets an installed plugin replace a builtin with the same ID', async () => {
    const { homeDir, workspaceRoot } = await fixture({ plugins: [{ id: 'context.code', enabled: false }] });
    const directory = join(homeDir, '.afk', 'plugins', 'context.code', 'dist');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.js'), `export default {
      manifest: { id: 'context.code', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true },
      activate(context) { context.registerContextProvider('replacement', { id: 'replacement', capabilities: { 'read-only': true, summarize: false, search: false }, async gather() { return []; } }); }
    };`);
    await writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'context.code', enabled: true }] }));
    const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
    runtimes.push(runtime);
    expect(runtime.getContextProvider('context.code')).toBeUndefined();
    expect(runtime.getContextProvider('replacement')).toBeDefined();
    expect((await runtime.diagnostics()).filter(item => item.severity === 'error')).toEqual([]);
  });

  it('maps a standard Git push event to configured managed work input', async () => {
    const input = { workItemId: 'github:acme/api#42', runOptions: { executionMode: 'batch' } };
    vi.mocked(executeWorkItem).mockResolvedValueOnce({ executionId: 'push-execution', workItemId: input.workItemId, status: 'merge_ready' });
    const { runtime } = await fixture({ plugins: [{ id: 'trigger.git-push', builtin: true, action: 'work-item.execute', config: { triggers: [{ id: 'main-push', kind: 'webhook', payload: { branch: 'main' }, input }] } }] }, { activateTriggers: true });
    const trigger = runtime.getTriggerProvider('trigger.git-push') as GitPushTriggerProvider;
    await expect(trigger.handlePush({ ref: 'refs/heads/main' })).resolves.toEqual({ dispatched: 1 });
    expect(executeWorkItem).toHaveBeenCalledWith(input, { plugins: runtime, agentProviderRegistry: expect.anything() });
  });
  it('dispatches managed workflow execution through the same plugin composition', async () => {
    const { runtime } = await fixture();
    vi.mocked(executeWorkItem).mockResolvedValueOnce({ executionId: 'test-execution', workItemId: 'github:acme/api#42', status: 'merge_ready' });
    const input = { workItemId: 'github:acme/api#42', runOptions: { executionMode: 'batch' as const } };
    await expect(runtime.dispatchSystemAction('work-item.execute', input)).resolves.toMatchObject({ status: 'merge_ready' });
    expect(executeWorkItem).toHaveBeenCalledWith(input, { plugins: runtime, agentProviderRegistry: expect.anything() });
    vi.mocked(executeWorkItem).mockResolvedValueOnce({ executionId: 'failed-execution', workItemId: input.workItemId, status: 'blocked' });
    await expect(runtime.dispatchSystemAction('work-item.execute', { input })).rejects.toThrow('blocked');
  });
  it.each(['external', 'symlink-escape'] as const)('binds the production verification workspace before calling its provider (%s)', async kind => {
    const { runtime, workspaceRoot, homeDir } = await fixture();
    const verify = vi.spyOn(runtime.getVerificationProvider('test-runner')!, 'verify')
      .mockResolvedValue({ passed: true, durationMs: 1, output: 'fixture' });
    const escape = join(workspaceRoot, 'escape');
    await symlink(homeDir, escape, 'dir');
    await expect(runtime.dispatchSystemAction('capability.invoke', {
      worktreePath: workspaceRoot,
      input: { capability: 'verification.provider', provider: 'test-runner', operation: 'verify',
        input: { target: kind === 'external' ? homeDir : escape } },
    }, { authorizedWorkspace: workspaceRoot })).rejects.toThrow('Verification target escapes authorized local workspace');
    expect(verify).not.toHaveBeenCalled();
  });

  it.each(['default', 'root', 'subdirectory'] as const)('preserves an allowed production verification workspace (%s)', async kind => {
    const { runtime, workspaceRoot } = await fixture();
    const verify = vi.spyOn(runtime.getVerificationProvider('test-runner')!, 'verify')
      .mockResolvedValue({ passed: true, durationMs: 1, output: 'fixture' });
    const child = join(workspaceRoot, 'child');
    await mkdir(child);
    const input = kind === 'default' ? {} : { target: kind === 'root' ? workspaceRoot : child };
    const options = { authorizedWorkspace: workspaceRoot, signal: new AbortController().signal };
    await expect(runtime.dispatchSystemAction('capability.invoke', {
      worktreePath: workspaceRoot,
      input: { capability: 'verification.provider', provider: 'test-runner', operation: 'verify', input },
    }, options)).resolves.toEqual({ passed: true, durationMs: 1, output: 'fixture' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledWith({ target: await realpath(kind === 'subdirectory' ? child : workspaceRoot) }, options);
  });

  it('loads shared providers and preserves false verification results as workflow failures', async () => {
    const { runtime, workspaceRoot } = await fixture();
    expect(runtime.listProviders('agent.provider')).toEqual(expect.arrayContaining(['claude-code', 'codex', 'cursor', 'pi', 'opencode', 'copilot']));
    expect(runtime.listProviders('host.connection')).toEqual(expect.arrayContaining(['ssh', 'jumpserver', 'aws-ssm', 'kubernetes-exec']));
    await expect(runtime.dispatchSystemAction('capability.invoke', {
      worktreePath: workspaceRoot,
      input: { capability: 'verification.provider', provider: 'test-runner', operation: 'verify', input: { command: [process.execPath, '-e', 'process.exit(7)'] } },
    }, { authorizedWorkspace: workspaceRoot })).rejects.toThrow('required check');
  });

  it.each([
    { plugins: 'invalid' },
    { integrations: { policies: [{ provider: 'secret-scan' }] } },
    { plugins: [{ id: 'notification.slack', builtin: true, config: {} }] },
  ])('reports invalid settings and blocks workflow initialization', async configuration => {
    const { runtime, lifecycle } = await fixture(configuration);
    expect((await runtime.diagnostics()).some(diagnostic => diagnostic.severity === 'error')).toBe(true);
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: '/' })).rejects.toThrow();
  });

  it('runs saved verifications against the execution worktree after agent work and before publishing', async () => {
    const command = [process.execPath, '-e', "require('node:fs').appendFileSync('verification-marker', process.cwd() + '\\n')"];
    const { runtime, lifecycle, context, homeDir, workspaceRoot } = await fixture({ integrations: { verifications: [{ provider: 'test-runner', command, timeoutMs: 5000 }] } });
    const verify = vi.spyOn(runtime.getVerificationProvider('test-runner')!, 'verify');
    const worktreePath = join(homeDir, 'verification-execution');
    await mkdir(worktreePath);
    const observed = await verificationContext(runtime, { ...context, worktreePath }, homeDir);
    await lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot });
    await lifecycle.run('after-agent', observed.context);
    await lifecycle.run('before-publish', observed.context);
    expect(verify).toHaveBeenCalledTimes(2);
    const actualWorktree = await realpath(worktreePath);
    expect(verify).toHaveBeenCalledWith({ command, timeoutMs: 5000, target: actualWorktree, executionId: expect.any(String) }, { authorizedWorkspace: actualWorktree });
    expect((await readFile(join(worktreePath, 'verification-marker'), 'utf8')).trim().split('\n')).toEqual([actualWorktree, actualWorktree]);
    await expect(lstat(join(workspaceRoot, 'verification-marker'))).rejects.toMatchObject({ code: 'ENOENT' });
    const history: RunEvent[] = [];
    for await (const event of observed.events.read('verification-run')) history.push(event);
    expect(history.map(event => event.type)).toEqual(['effect.started', 'effect.completed', 'effect.started', 'effect.completed']);
    expect(history.every(event => event.context.runId === 'verification-run' && event.context.workItemId === 'github:acme/api#42')).toBe(true);
    const completed = history.filter(event => event.type === 'effect.completed');
    expect(new Set(completed.map(event => event.idempotencyKey)).size).toBe(2);
    const evidence = await createLocalEncryptedEvidenceStore(homeDir);
    for (const event of completed) {
      expect(event.evidence).toHaveLength(1);
      const receipt = JSON.parse(Buffer.from(await evidence.get(event.evidence![0])).toString('utf8'));
      expect(receipt).toMatchObject({ protocol: 'capability-verification-v1', provider: 'test-runner',
        observation: observed.context.observation!.context, workspace: actualWorktree,
        revision: { before: { head: observed.revision }, after: { head: observed.revision } },
        result: { passed: true, execution: { command, cwd: actualWorktree, exitCode: 0, closed: true } } });
    }
    expect((await observed.events.verify('verification-run')).valid).toBe(true);
  });

  it.each(['after-agent', 'before-publish'] as const)('blocks %s when the saved verification actually fails', async phase => {
    const { runtime, lifecycle, context, homeDir } = await fixture({ integrations: { verifications: [{ provider: 'test-runner',
      command: [process.execPath, '-e', 'process.exit(7)'] }] } });
    const observed = await verificationContext(runtime, context, homeDir);
    await expect(lifecycle.run(phase, observed.context)).rejects.toThrow('Capability verification failed');
    const history: RunEvent[] = [];
    for await (const event of observed.events.read('verification-run')) history.push(event);
    const evidence = await createLocalEncryptedEvidenceStore(homeDir);
    const completed = history.find(event => event.type === 'effect.completed')!;
    expect(completed.evidence).toHaveLength(1);
    const receipt = JSON.parse(Buffer.from(await evidence.get(completed.evidence![0])).toString('utf8'));
    expect(receipt).toMatchObject({ result: { passed: false, execution: { exitCode: 7, closed: true } } });
  });

  it('does not invoke an unselected registered verifier', async () => {
    const { runtime, lifecycle, context } = await fixture({ integrations: {} });
    const verify = vi.spyOn(runtime.getVerificationProvider('test-runner')!, 'verify');
    await lifecycle.run('after-agent', context);
    await lifecycle.run('before-publish', context);
    expect(verify).not.toHaveBeenCalled();
  });

  it.each([false, true])('blocks initialization when a saved verification provider is missing or disabled=%s', async disabled => {
    const { lifecycle, workspaceRoot } = await fixture({
      plugins: disabled ? [{ id: 'verification.test-runner', builtin: true, enabled: false }] : [],
      integrations: { verifications: [{ provider: disabled ? 'test-runner' : 'missing-verifier' }] },
    });
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot }))
      .rejects.toThrow('Configured verification provider is unavailable');
  });

  it.each([
    { plugins: [{ id: 'workflow.integrations', builtin: true, enabled: false }], integrations: { verifications: [{ provider: 'missing-verifier' }] } },
    { plugins: [{ id: 'workflow.integrations', builtin: true, enabled: false }, { id: 'verification.test-runner', builtin: true, enabled: false }], integrations: { verifications: [{ provider: 'test-runner' }] } },
    { plugins: [{ id: 'workflow.integrations', builtin: true, enabled: false }], integrations: { verifications: [{ provider: 'test-runner', command: [process.execPath, '-e', 'process.exit(7)'] }] } },
    { plugins: [{ id: 'workflow.integrations' }], integrations: { verifications: [{ provider: 'test-runner' }] } },
    { plugins: [{ id: 'workflow.integrations', builtin: true, enabled: false }], integrations: { policies: [{ provider: 'secret-scan', input: { action: 'pre-execution' } }] } },
  ])('rejects a missing required integration gate despite saved selections: %j', async configuration => {
    const { runtime, lifecycle, workspaceRoot } = await fixture(configuration);
    const verify = runtime.getVerificationProvider('test-runner');
    const execute = verify && vi.spyOn(verify, 'verify');
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot }))
      .rejects.toThrow('Configured capability gates are unavailable');
    if (execute) expect(execute).not.toHaveBeenCalled();
    expect(await runtime.diagnostics()).toContainEqual(expect.objectContaining({ code: 'config.integrations-unavailable', severity: 'error' }));
  });

  it('allows a disabled integration module when no required gates are selected', async () => {
    const { lifecycle, workspaceRoot } = await fixture({ plugins: [{ id: 'workflow.integrations', builtin: true, enabled: false }], integrations: {} });
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot })).resolves.toBeUndefined();
  });

  it('rejects a replacement plugin that omits the required integration gate', async () => {
    const { homeDir, workspaceRoot } = await fixture();
    const directory = join(homeDir, '.afk', 'plugins', 'workflow.integrations', 'dist');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'index.js'), `export default {
      manifest: { id: 'workflow.integrations', version: '1.0.0', apiVersion: 1, provides: [], trusted: true },
      activate() {}
    };`);
    await writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'workflow.integrations' }],
      integrations: { verifications: [{ provider: 'test-runner' }] } }));
    const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
    runtimes.push(runtime);
    expect(runtime.getPlugin('workflow.integrations')).toBeDefined();
    const lifecycle = new LifecycleDispatcher(runtime.getLifecycleModules());
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot }))
      .rejects.toThrow('Configured capability gates are unavailable');
  });

  it('rejects more than 32 saved verification selections', async () => {
    const { lifecycle, workspaceRoot } = await fixture({ integrations: { verifications: Array.from({ length: 33 }, () => ({ provider: 'test-runner' })) } });
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot })).rejects.toThrow();
  });

  it.each([
    { provider: 'test-runner', target: '/untrusted-target' },
    { provider: 'test-runner', passed: true },
    { provider: 'test-runner', command: [] },
    { provider: 'test-runner', command: ['tool', '\0'] },
    { provider: 'test-runner', timeoutMs: 0 },
  ])('rejects invalid saved verification selection before execution: %j', async verification => {
    const { lifecycle, workspaceRoot } = await fixture({ integrations: { verifications: [verification] } });
    await expect(lifecycle.run('init', { iid: 42, projectName: undefined, baseBranch: 'main', params: {}, originalCwd: workspaceRoot })).rejects.toThrow();
  });

  it.each([false, true])('gathers code context for the execution worktree (explicit root: %s)', async fixedRoot => {
    const query = { scope: 'widget.ts', prompt: 'widget' };
    const { workspaceRoot, homeDir, context, lifecycle, runtime } = await fixture({
      plugins: fixedRoot ? [{ id: 'context.code', builtin: true, config: { root: '.' } }] : [],
      integrations: { contexts: [{ provider: 'context.code', query }] },
    });
    const worktreePath = join(homeDir, 'execution');
    const execution = { ...context, worktreePath };
    const output = join(worktreePath, '.afk', 'plugin-context.md');
    await mkdir(worktreePath);
    await writeFile(join(workspaceRoot, 'widget.ts'), 'export const widget = "source-checkout";');
    await writeFile(join(worktreePath, 'widget.ts'), 'export const widget = "execution-worktree";');
    await expect(runtime.dispatchSystemAction('capability.invoke', { capability: 'context.provider', provider: 'context.code', operation: 'gather', input: query }))
      .resolves.toMatchObject([{ origin: 'widget.ts', content: expect.stringContaining('source-checkout') }]);
    await lifecycle.run('before-agent', execution);
    const contents = await readFile(output, 'utf8');
    expect(contents).toContain(fixedRoot ? 'source-checkout' : 'execution-worktree');
    expect(contents).not.toContain(fixedRoot ? 'execution-worktree' : 'source-checkout');
    await expect(readFile(join(workspaceRoot, '.afk', 'plugin-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await lifecycle.run('cleanup', execution);
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('blocks publishing generated secrets from the actual worktree rather than scanning the source checkout', async () => {
    const { lifecycle, context, homeDir } = await fixture({ integrations: { policies: [{ provider: 'secret-scan', input: { action: 'publish' } }] } });
    const worktreePath = join(homeDir, 'execution');
    await mkdir(worktreePath);
    await lifecycle.run('before-agent', { ...context, worktreePath });
    await writeFile(join(worktreePath, 'generated.env'), 'password=synthetic-sensitive-value');
    await expect(lifecycle.run('before-publish', { ...context, worktreePath })).rejects.toThrow('Execution denied by capability policy');
  });
  it('never includes malformed YAML source text in diagnostics', async () => {
    const { homeDir, workspaceRoot } = await fixture();
    await writeFile(join(homeDir, '.afk', 'plugins.yml'), 'token: SYNTHETIC_SECRET_VALUE: invalid');
    const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
    runtimes.push(runtime);
    expect(JSON.stringify(await runtime.diagnostics())).not.toContain('SYNTHETIC_SECRET_VALUE');
    expect(runtime.getPlugin('workflow.invalid-settings')).toBeDefined();
  });

  it('rejects context output through an execution worktree symlink', async () => {
    const { workspaceRoot, context, lifecycle, homeDir } = await fixture({ integrations: { contexts: [{ provider: 'context.code', query: { scope: 'widget.ts', prompt: 'widget' } }] } });
    await writeFile(join(workspaceRoot, 'widget.ts'), 'widget');
    await symlink(homeDir, join(workspaceRoot, '.afk'));
    await expect(lifecycle.run('before-agent', context)).rejects.toThrow('symbolic link');
    await expect(readFile(join(homeDir, 'plugin-context.md'))).rejects.toThrow();
  });

  it('configures trigger providers without starting timers in ordinary execution', async () => {
    const timer = vi.spyOn(globalThis, 'setInterval');
    try {
      const { runtime } = await fixture({ plugins: [{ id: 'trigger.schedule', builtin: true, config: { triggers: [{ id: 'interval', kind: 'schedule', schedule: '1000' }] } }] });
      expect(timer).not.toHaveBeenCalled();
      expect(runtime.getPlugin('workflow.invalid-settings')).toBeUndefined();
    } finally { timer.mockRestore(); }
  });
  it('activates schedules only for the listener and dispatches nested operation input', async () => {
    vi.useFakeTimers();
    try {
      const payload = { capability: 'context.provider', provider: 'context.code', operation: 'gather', input: { scope: '.', prompt: 'widget' } };
      const { runtime } = await fixture({ plugins: [{ id: 'trigger.schedule', builtin: true, action: 'capability.invoke', config: { triggers: [{ id: 'interval', kind: 'schedule', schedule: '1000', payload }] } }] }, { activateTriggers: true });
      const capture = vi.spyOn(runtime.getContextProvider('context.code')!, 'gather').mockResolvedValue([]);
      expect(runtime.getPlugin('workflow.invalid-settings')).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1000);
      expect(pluginTriggerQueue(runtime)!.status()).toEqual([expect.objectContaining({ providerId: 'trigger.schedule', status: 'pending' })]);
      expect(capture).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(capture).toHaveBeenCalledWith(payload.input);
      await runtime.dispose();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('disarms schedules whose action is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const { runtime } = await fixture({ plugins: [{ id: 'trigger.schedule', builtin: true, action: 'missing.action', config: { triggers: [{ id: 'interval', kind: 'schedule', schedule: '1000' }] } }] }, { activateTriggers: true });
      expect(runtime.getTriggerProvider('trigger.schedule')).toBeUndefined();
      expect((await runtime.diagnostics()).some(result => result.code === 'trigger.action-missing')).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
