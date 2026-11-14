import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { builtinPluginManifests } from './builtin-manifests.js';
import { inspectConfiguredPlugins } from './configured.js';
import { listPluginInventory, diagnosePluginInventory } from './inventory.js';

vi.mock('../../infrastructure/providers/index.js', async original => {
  const exports = await original<typeof import('../../infrastructure/providers/index.js')>();
  return Object.fromEntries(Object.entries(exports).map(([key, value]) => [key,
    typeof value === 'function' && /Provider$|Store$/.test(key) ? vi.fn(() => { throw new Error(`Constructor forbidden: ${key}`); }) : value]));
});
vi.mock('./builtin-providers.js', () => ({
  createBuiltinAgentPlugins: () => { throw new Error('Agent construction forbidden'); },
  createBuiltinSandboxPlugins: () => { throw new Error('Sandbox construction forbidden'); },
  createBuiltinVerificationPlugins: () => { throw new Error('Verification construction forbidden'); },
}));

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});
async function home() {
  const directory = await mkdtemp(join(tmpdir(), 'static-inventory-'));
  directories.push(directory);
  return directory;
}

describe('passive inventory', () => {
  it('reads installed metadata without importing an entry and never fetches, constructs providers or resolves secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
    const homeDir = await home();
    const directory = join(homeDir, '.afk', 'plugins', 'context.static');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'entry.js'), 'throw new Error("Installed entry imported");');
    await writeFile(join(directory, 'install.json'), JSON.stringify({ id: 'context.static', version: '1.0.0', entry: 'entry.js',
      manifest: { id: 'context.static', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['context.provider'] } }));
    const environment = {};
    expect(builtinPluginManifests(homeDir).length).toBeGreaterThan(20);
    expect(inspectConfiguredPlugins({ configurations: [{ id: 'notification.slack', config: { webhook: { env: 'UNREAD' } } }], environment })[0].manifest.provides).toEqual(['notification.provider']);
    const rows = await listPluginInventory({ homeDir, configuration: { plugins: [
      { id: 'context.static' },
      { id: 'artifact.report-platform', builtin: true, config: { endpoint: 'https://reports.invalid', token: { env: 'UNREAD' } } },
    ] } });
    expect(rows.find(row => row.id === 'context.static')?.configuration).toBe('valid');
    expect(rows.find(row => row.id === 'artifact.report-platform')?.configuration).toBe('valid');
    const execute = vi.fn(() => { throw new Error('Execution forbidden'); });
    expect((await diagnosePluginInventory(rows, { execute })).every(tool => tool.reason === 'not-requested')).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(rows)).not.toContain('UNREAD');
  });

  it('reports invalid shape, unknown installed metadata, missing credentials and cycles', async () => {
    const rows = await listPluginInventory({ homeDir: await home(), configuration: { plugins: [
      { id: 'host.ssh', builtin: true, config: { hosts: [] } },
      { id: 'context.missing' },
      { id: 'notification.slack', builtin: true, config: { webhook: { provider: 'credential.missing', name: 'test' } } },
      { id: 'credential.enterprise', builtin: true, config: { values: { a: { provider: 'credential.oauth', name: 'test' } } } },
      { id: 'credential.oauth', builtin: true, config: { tokenEndpoint: 'https://auth.invalid', clientId: 'test', clientSecret: { provider: 'credential.enterprise', name: 'test' } } },
    ] } });
    expect(rows.find(row => row.id === 'host.ssh')?.configuration).toBe('invalid');
    expect(rows.find(row => row.id === 'context.missing')?.configuration).toBe('unavailable');
    for (const id of ['notification.slack', 'credential.enterprise', 'credential.oauth']) expect(rows.find(row => row.id === id)?.diagnostics).toContainEqual(expect.objectContaining({ code: 'config.dependencies' }));
  });

  it('never probes a default when configured commands use a different binding', async () => {
    const execute = vi.fn(async (_request: import('./external-tools.js').VersionProbeRequest) => ({ stdout: '9.0.0', stderr: '' }));
    const rows = await listPluginInventory({ configuration: { plugins: [
      { id: 'host.ssh', builtin: true, config: { hosts: [{ alias: 'a', address: 'a' }], binary: '/opt/custom/ssh', scpBinary: 'different-scp' } },
      { id: 'verification.browser-check', builtin: true, config: { command: ['/opt/check', '--custom'] } },
    ] } });
    const selected = rows.filter(row => ['host.ssh', 'verification.browser-check'].includes(row.id));
    const tools = await diagnosePluginInventory(selected, { probe: true, execute, executorLifecycle: 'trusted-cooperative' });
    expect(tools.map(tool => 'command' in tool ? tool.command : undefined)).toEqual(['/opt/custom/ssh', 'different-scp', '/opt/check']);
    expect(tools.every(tool => tool.status === 'unsupported' && tool.reason === 'custom-binding')).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(selected[0].manifest?.externalTools).toEqual([]);
  });

  it('approves only builtin exact tuples and leaves backend-required without host fallback', async () => {
    const execute = vi.fn(async (_request: import('./external-tools.js').VersionProbeRequest) => ({ stdout: '9.0.0', stderr: '' }));
    const rows = await listPluginInventory({ configuration: { plugins: [] } });
    const selected = rows.filter(row => ['host.ssh', 'agent.codex'].includes(row.id));
    const tools = await diagnosePluginInventory(selected, { probe: true, execute, executorLifecycle: 'trusted-cooperative' });
    expect(tools).toContainEqual(expect.objectContaining({ id: 'codex', reason: 'backend-required' }));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({ command: 'ssh', args: ['-V'] });
  });

  it('refuses installed manifest version argv even when trusted and --probe was requested', async () => {
    const homeDir = await home();
    const directory = join(homeDir, '.afk', 'plugins', 'host.ssh');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'install.json'), JSON.stringify({ id: 'host.ssh', version: '1.0.0', manifest: {
      id: 'host.ssh', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['host.connection'], externalTools: [
        { id: 'node', command: 'node', location: 'host', source: { url: 'https://example.invalid/' }, version: { args: ['--eval', 'throw new Error("malicious")'] } },
      ],
    } }));
    const rows = await listPluginInventory({ homeDir, configuration: { plugins: [{ id: 'host.ssh', builtin: false }] } });
    const execute = vi.fn(async (_request: import('./external-tools.js').VersionProbeRequest) => ({ stdout: '9.0.0', stderr: '' }));
    const tools = await diagnosePluginInventory(rows.filter(row => row.id === 'host.ssh'), { probe: true, execute, executorLifecycle: 'trusted-cooperative' });
    expect(tools).toEqual([expect.objectContaining({ reason: 'not-approved' })]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves SDK timeout/cancellation and late cleanup-unconfirmed on the product route', async () => {
    const rows = (await listPluginInventory({ configuration: { plugins: [] } })).filter(row => row.id === 'sandbox.docker');
    const abort = new AbortController();
    const execute = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
      await new Promise<void>(resolve => signal.addEventListener('abort', () => setTimeout(resolve, 5), { once: true }));
      throw Object.assign(new Error('Cleanup failed'), { code: 'PROBE_CLEANUP_UNCONFIRMED' });
    });
    const pending = diagnosePluginInventory(rows, { probe: true, execute, executorLifecycle: 'trusted-cooperative', signal: abort.signal });
    setTimeout(() => abort.abort(), 10);
    expect(await pending).toEqual([expect.objectContaining({ reason: 'cancelled', cleanup: 'unconfirmed' })]);
    expect(await diagnosePluginInventory(rows, { probe: true, execute, executorLifecycle: 'trusted-cooperative', timeoutMs: 10 }))
      .toEqual([expect.objectContaining({ reason: 'timeout', cleanup: 'unconfirmed' })]);
  });


});


it('reports cycles between installed capability declarations without importing entries', async () => {
  const homeDir = await home();
  for (const [id, provides, requires] of [['context.cycle-a', 'custom.a', 'custom.b'], ['context.cycle-b', 'custom.b', 'custom.a']]) {
    const directory = join(homeDir, '.afk', 'plugins', id);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'install.json'), JSON.stringify({ id, version: '1.0.0', manifest: { id, version: '1.0.0', apiVersion: 1, trusted: true, provides: [provides], requires: [requires] } }));
  }
  const rows = await listPluginInventory({ homeDir, configuration: { plugins: [{ id: 'context.cycle-a' }, { id: 'context.cycle-b' }] } });
  for (const row of rows.filter(row => row.id.startsWith('context.cycle-'))) expect(row.diagnostics).toContainEqual(expect.objectContaining({ code: 'config.dependencies' }));
});

it.each([
  ['missing', async () => { throw Object.assign(new Error('not found'), { code: 'ENOENT' }); }, 'missing', undefined],
  ['output', async () => ({ stdout: 'x'.repeat(5000), stderr: '' }), 'unknown', 'output-limit'],
  ['version', async () => ({ stdout: 'not a version', stderr: '' }), 'unknown', 'unrecognized-version'],
] as const)('retains %s results through static inventory doctor', async (_name, execute, status, reason) => {
  const rows = (await listPluginInventory({ configuration: { plugins: [] } })).filter(row => row.id === 'sandbox.docker');
  expect(await diagnosePluginInventory(rows, { probe: true, execute, executorLifecycle: 'trusted-cooperative' }))
    .toEqual([expect.objectContaining({ status, ...(reason ? { reason } : {}) })]);
});

it('reports unsupported platform and architecture before execution', async () => {
  const rows = (await listPluginInventory({ configuration: { plugins: [] } })).filter(row => row.id === 'sandbox.docker');
  const execute = vi.fn(async () => ({ stdout: '1.0.0', stderr: '' }));
  for (const restriction of [{ platforms: [process.platform === 'linux' ? 'darwin' : 'linux'] as const }, { architectures: [process.arch === 'x64' ? 'arm64' : 'x64'] as const }]) {
    const selected = rows.map(row => ({ ...row, manifest: { ...row.manifest!, externalTools: row.manifest!.externalTools!.map(tool => ({ ...tool, ...restriction })) } }));
    expect(await diagnosePluginInventory(selected, { probe: true, execute, executorLifecycle: 'trusted-cooperative' }))
      .toEqual([expect.objectContaining({ status: 'unsupported' })]);
  }
  expect(execute).not.toHaveBeenCalled();
});


it('does not accept a raw backend executor through the product options seam', async () => {
  const rows = (await listPluginInventory({ configuration: { plugins: [] } })).filter(row => row.id === 'agent.codex');
  const execute = vi.fn(async () => ({ stdout: '9.0.0', stderr: '' }));
  const unselectedBackend = { platform: process.platform, architecture: process.arch, execute, lifecycle: 'trusted-cooperative' as const };
  const options = { probe: true, backend: unselectedBackend };
  expect(await diagnosePluginInventory(rows, options)).toEqual([expect.objectContaining({ reason: 'backend-required' })]);
  expect(execute).not.toHaveBeenCalled();
});

describe('whole inventory diagnosis deadline', () => {
  it.each([30, undefined])('shares one execution budget (%s) and preserves active cleanup before skipping later rows', async timeoutMs => {
    const rows = (await listPluginInventory({ configuration: { plugins: [] } }))
      .filter(row => ['host.aws-ssm', 'host.kubernetes-exec', 'sandbox.docker', 'sandbox.podman'].includes(row.id));
    const execute = vi.fn((request: import('./external-tools.js').VersionProbeRequest) => new Promise<never>((_resolve, reject) => {
      request.signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('Cleanup unconfirmed'), { code: 'PROBE_CLEANUP_UNCONFIRMED' })), 5), { once: true });
    }));
    vi.useFakeTimers();
    try {
      const pending = diagnosePluginInventory(rows, { probe: true, execute, executorLifecycle: 'trusted-cooperative', timeoutMs });
      await vi.runAllTimersAsync();
      const actual = await pending;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(actual.map(result => result.pluginId)).toEqual(rows.map(row => row.id));
      expect(actual).toEqual(rows.map((row, index) => ({ pluginId: row.id, id: row.manifest!.externalTools![0].id,
        location: 'host', status: 'unknown', reason: 'timeout', ...(index === 0 ? { cleanup: 'unconfirmed' } : {}) })));
      expect(execute.mock.calls[0][0].timeoutMs).toBe(timeoutMs ?? 3000);
    } finally { vi.useRealTimers(); }
  });

  it('passes only the remaining execution budget after an earlier plugin succeeds', async () => {
    const rows = (await listPluginInventory({ configuration: { plugins: [] } }))
      .filter(row => ['host.aws-ssm', 'host.kubernetes-exec', 'sandbox.docker'].includes(row.id));
    let calls = 0;
    const execute = vi.fn((request: import('./external-tools.js').VersionProbeRequest) => new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      if (++calls === 1) setTimeout(() => resolve({ stdout: '1.0.0', stderr: '' }), 20);
      else request.signal.addEventListener('abort', () => setTimeout(() => reject(Object.assign(new Error('Cleanup unconfirmed'), { code: 'PROBE_CLEANUP_UNCONFIRMED' })), 5), { once: true });
    }));
    vi.useFakeTimers();
    try {
      const pending = diagnosePluginInventory(rows, { probe: true, timeoutMs: 30, execute, executorLifecycle: 'trusted-cooperative' });
      await vi.runAllTimersAsync();
      const actual = await pending;
      expect(execute.mock.calls.map(([request]) => request.timeoutMs)).toEqual([30, 10]);
      expect(actual).toEqual([
        expect.objectContaining({ pluginId: rows[0].id, status: 'available' }),
        expect.objectContaining({ pluginId: rows[1].id, reason: 'timeout', cleanup: 'unconfirmed' }),
        expect.objectContaining({ pluginId: rows[2].id, reason: 'timeout' }),
      ]);
    } finally { vi.useRealTimers(); }
  });
});
