import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialValue, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';
import { LifecycleDispatcher } from '../workflows/lifecycle.js';
import { createConfiguredPlugins, getConfiguredCredentialDependencies, inspectConfiguredPlugins } from './configured.js';
import { createDefaultPluginRuntime } from './default-runtime.js';
import { PluginManager } from './manager.js';
import { readPluginConfiguration } from './configuration.js';
import { PluginRuntime } from './runtime.js';

const endpoint = 'https://knowledge.example/query';
const query = { scope: 'github:example/project', prompt: 'retry safely' };
const reference = { provider: 'credential.fixture', name: 'knowledge', scope: 'read' };
const credentialPluginId = 'credential.fixture-owner';
const runtimes: PluginRuntime[] = [];
const directories: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function fixture(expiresAt?: string) {
  const runtime = new PluginRuntime();
  runtimes.push(runtime);
  const resolve = vi.fn(async (_ref: unknown, _options?: ProviderOperationOptions): Promise<CredentialValue> => ({ secret: 'first' }));
  await runtime.activate({
    manifest: { id: credentialPluginId, version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
    activate(context) {
      context.registerCredentialProvider(reference.provider, { id: reference.provider, capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve });
    },
  });
  const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockImplementation(async () => Response.json([{ origin: 'knowledge/retries', content: 'Reuse the operation identity.' }]));
  const [plugin] = await createConfiguredPlugins({ configurations: [{ id: 'context.knowledge-base', config: { endpoint, token: { ...reference, ...(expiresAt ? { expiresAt } : {}) }, timeoutMs: 1000 } }], fetch });
  await runtime.activate(plugin);
  return { runtime, plugin, resolve, fetch, source: runtime.getContextProvider('context.knowledge-base')! };
}

describe('configured knowledge-base credentials', () => {
  it('inspects references passively and orders their exact credential dependency', () => {
    const rows = inspectConfiguredPlugins({ configurations: [
      { id: 'context.knowledge-base', config: { endpoint, token: { provider: 'credential.enterprise', name: 'knowledge' } } },
      { id: 'credential.enterprise', config: { values: { knowledge: { env: 'UNREAD_KNOWLEDGE_TOKEN' } } } },
    ], environment: {} });
    expect(rows.map(row => row.manifest.id)).toEqual(['credential.enterprise', 'context.knowledge-base']);
    expect(rows[1]).toMatchObject({ credentialDependencies: ['credential.enterprise'], manifest: { requires: ['credential.provider'] } });
  });

  it('activates passively, refreshes each gather and retains credential ownership', async () => {
    const { runtime, plugin, resolve, fetch, source } = await fixture();
    await runtime.diagnostics();
    expect(resolve).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(getConfiguredCredentialDependencies(plugin)).toEqual([reference.provider]);
    await expect(runtime.dispose(credentialPluginId)).rejects.toThrow('required');
    const options = { signal: new AbortController().signal, deadlineAt: Date.now() + 5000 };
    await expect(source.gather(query, options)).resolves.toEqual([{ origin: 'knowledge/retries', content: 'Reuse the operation identity.' }]);
    resolve.mockResolvedValueOnce({ secret: 'rotated' });
    await source.gather(query, options);
    expect(fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get('authorization'))).toEqual(['Bearer first', 'Bearer rotated']);
    expect(resolve.mock.calls).toEqual(Array.from({ length: 2 }, () => [{ name: reference.name, scope: reference.scope }, options]));
    await runtime.dispose(plugin.manifest.id);
    await expect(source.gather(query)).rejects.toThrow(/^Operation credential unavailable$/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing named credential even when another provider is active', async () => {
    const runtime = new PluginRuntime();
    runtimes.push(runtime);
    const resolve = vi.fn(async () => ({ secret: 'unrelated' }));
    await runtime.activate({
      manifest: { id: 'credential.unrelated', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
      activate(context) {
        context.registerCredentialProvider('credential.unrelated', { id: 'credential.unrelated', capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve });
      },
    });
    const [plugin] = await createConfiguredPlugins({ configurations: [{ id: 'context.knowledge-base', config: { endpoint, token: reference } }] });
    await expect(runtime.activate(plugin)).rejects.toThrow('credential provider is not active');
    expect(resolve).not.toHaveBeenCalled();
    expect(runtime.getContextProvider('context.knowledge-base')).toBeUndefined();
  });

  it('rejects credentials that arrive after the consumer is disposed', async () => {
    const { source, runtime, plugin, resolve, fetch } = await fixture();
    let finish!: (value: CredentialValue) => void;
    resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const outcome = source.gather(query).catch(error => error as Error);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    await runtime.dispose(plugin.manifest.id);
    finish({ secret: 'late' });
    expect(await outcome).toEqual(new Error('Operation credential unavailable'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rechecks reference expiry when a pending credential arrives', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-17T00:00:00Z'));
    const { source, resolve, fetch } = await fixture('2026-11-17T00:00:01Z');
    let finish!: (value: CredentialValue) => void;
    resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const outcome = source.gather(query).catch(error => error as Error);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    vi.setSystemTime(new Date('2026-11-17T00:00:01Z'));
    finish({ secret: 'late' });
    expect(await outcome).toEqual(new Error('Operation credential unavailable'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('starts the HTTP timeout after credential resolution', async () => {
    vi.useFakeTimers();
    const { source, resolve, fetch } = await fixture();
    let finish!: (value: CredentialValue) => void;
    resolve.mockImplementationOnce(() => new Promise(done => { finish = done; }));
    const outcome = source.gather(query);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1001);
    expect(fetch).not.toHaveBeenCalled();
    finish({ secret: 'resolved' });
    await expect(outcome).resolves.toEqual([{ origin: 'knowledge/retries', content: 'Reuse the operation identity.' }]);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    { secret: 'revoked', revoked: true },
    { secret: 'expired', expiresAt: '2000-01-01T00:00:00Z' },
  ])('blocks invalid credentials after an earlier success: %j', async credential => {
    const { source, resolve, fetch } = await fixture();
    await source.gather(query);
    resolve.mockResolvedValue(credential);
    await expect(source.gather(query)).rejects.toThrow(/^Operation credential unavailable$/);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each<Record<string, PluginConfigValue>>([
    { endpoint: 'http://knowledge.example/query', token: reference },
    { endpoint, token: 'inline-secret' },
    { endpoint, token: { ...reference, expiresAt: 'tomorrow' } },
    { endpoint, token: reference, timeoutMs: 0 },
    { endpoint, token: reference, timeoutMs: 300_001 },
    { endpoint, token: reference, unexpected: true },
  ])('rejects invalid saved configuration without exposing secrets: %j', config => {
    expect(() => inspectConfiguredPlugins({ configurations: [{ id: 'context.knowledge-base', config }] })).toThrow('invalid configuration fields');
  });

  it('accepts the HTTP timeout upper bound without resolving credentials', () => {
    expect(() => inspectConfiguredPlugins({ configurations: [{ id: 'context.knowledge-base', config: { endpoint, token: reference, timeoutMs: 300_000 } }] })).not.toThrow();
  });

  it('consumes saved credentials through the default before-agent integration and blocks expired references', async () => {
    const root = await mkdtemp(join(tmpdir(), 'knowledge-configuration-'));
    directories.push(root);
    const homeDir = join(root, 'home');
    const workspaceRoot = join(root, 'workspace');
    await mkdir(workspaceRoot);
    const fetch = vi.fn<Parameters<typeof globalThis.fetch>, ReturnType<typeof globalThis.fetch>>().mockImplementation(async () => Response.json([{ origin: 'knowledge/retries', content: 'Reuse the operation identity.' }]));
    vi.stubGlobal('fetch', fetch);
    vi.stubEnv('KNOWLEDGE_FIXTURE_TOKEN', 'saved-private-token');
    const manager = new PluginManager({ homeDir });
    const config = { endpoint, token: { provider: 'credential.enterprise', name: 'knowledge' }, timeoutMs: 1000 };
    await manager.configure('credential.enterprise', { values: { knowledge: { env: 'KNOWLEDGE_FIXTURE_TOKEN' } } }, true);
    await manager.configure('context.knowledge-base', config, true);
    expect(fetch).not.toHaveBeenCalled();
    const saved = readPluginConfiguration(homeDir);
    expect(saved.plugins.find(plugin => plugin.id === 'context.knowledge-base')?.config).toEqual(config);
    const configurationFile = join(homeDir, '.afk', 'plugins.yml');
    await writeFile(configurationFile, JSON.stringify({ ...saved, integrations: { contexts: [{ provider: 'context.knowledge-base', query }] } }));
    const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
    runtimes.push(runtime);
    expect(fetch).not.toHaveBeenCalled();
    const context = { iid: 42, worktreePath: workspaceRoot, baseBranch: 'main', sessionName: 'knowledge-42', params: {} };
    await new LifecycleDispatcher(runtime.getLifecycleModules()).run('before-agent', context);
    expect(fetch).toHaveBeenCalledOnce();
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer saved-private-token');
    const material = await readFile(join(workspaceRoot, '.afk', 'plugin-context.md'), 'utf8');
    expect(material).toContain('Reuse the operation identity.');
    expect(material).not.toContain('saved-private-token');
    await runtime.close();
    await manager.configure('context.knowledge-base', { ...config, token: { ...config.token, expiresAt: '2000-01-01T00:00:00Z' } }, true);
    const restarted = await createDefaultPluginRuntime({ homeDir, workspaceRoot });
    runtimes.push(restarted);
    await expect(new LifecycleDispatcher(restarted.getLifecycleModules()).run('before-agent', context)).rejects.toThrow('Operation credential unavailable');
    expect(fetch).toHaveBeenCalledOnce();
  });
});
