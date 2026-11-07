import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManager, readInstalledPlugin } from './manager.js';
import { readPluginConfiguration } from './configuration.js';
import { loadInstalledPlugins } from './loader.js';
import { PluginRuntime } from './runtime.js';
import type { PluginManifest } from '../../plugin-sdk/profile.js';

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(version = '1.0.0', overrides: Partial<PluginManifest> = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'plugin-install-'));
  directories.push(root);
  const source = join(root, 'source');
  const homeDir = join(root, 'home');
  await fs.mkdir(join(source, 'dist'), { recursive: true });
  await fs.writeFile(join(source, 'package.json'), '{"name":"context-example","type":"module"}');
  const manifest = {
    id: 'context.example', version, apiVersion: 1, trusted: true,
    provides: ['context.provider'],
    configSchema: { type: 'object', properties: { scope: { type: 'string' } }, required: ['scope'], additionalProperties: false },
    ...overrides,
  };
  await fs.writeFile(join(source, 'plugin.json'), JSON.stringify(manifest));
  await fs.writeFile(join(source, 'dist', 'index.js'), `
    export default ({configuration}) => ({
      manifest: ${JSON.stringify(manifest)},
      activate(context) {
        context.registerContextProvider('example', { id: 'example', capabilities: {search: true}, gather: async () => [{origin: configuration.scope, content: 'ready'}] });
      }
    });
  `);
  return { source, homeDir, root };
}

async function dependencyFixture(capability = 'example.provider', providerId = 'example.primary', dependentOverrides: Partial<PluginManifest> = {}) {
  const provider = await fixture('1.0.0', { id: providerId, provides: [capability], configSchema: undefined });
  const dependent = await fixture('1.0.0', { id: 'example.dependent', provides: [], requires: [capability], configSchema: undefined, ...dependentOverrides });
  const marker = join(provider.root, 'executed');
  await fs.writeFile(join(dependent.source, 'dist', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('must not execute');`);
  const manager = new PluginManager({ homeDir: provider.homeDir });
  await manager.install(provider.source);
  await manager.install(dependent.source);
  return { ...provider, manager, marker, configPath: join(provider.homeDir, '.afk', 'plugins.yml') };
}

describe('PluginManager', () => {
  describe.each(['disable', 'remove'] as const)('%s dependency protection', operation => {
    it('preserves disk state when an enabled dependent needs the last provider without executing plugins', async () => {
      const { manager, homeDir, marker, configPath } = await dependencyFixture();
      const previous = await fs.readFile(configPath, 'utf8');
      const mutation = operation === 'remove' ? manager.remove('example.primary') : manager.setEnabled('example.primary', false);
      await expect(mutation).rejects.toThrow(/example.primary.*example.dependent/);
      expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
      expect(await readInstalledPlugin(join(homeDir, '.afk', 'plugins', 'example.primary'))).toBeDefined();
      expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
    });

    it('allows another enabled provider and ignores a disabled dependent', async () => {
      const { manager, homeDir } = await dependencyFixture();
      const alternative = await fixture('1.0.0', { id: 'example.alternative', provides: ['example.provider'], configSchema: undefined });
      await manager.install(alternative.source);
      if (operation === 'remove') await manager.remove('example.primary');
      else await manager.setEnabled('example.primary', false);
      await manager.setEnabled('example.dependent', false);
      if (operation === 'remove') await manager.remove('example.alternative');
      else await manager.setEnabled('example.alternative', false);
      expect(readPluginConfiguration(homeDir).plugins.find(entry => entry.id === 'example.alternative')?.enabled).toBe(false);
    });

    it('does not count a disabled alternative', async () => {
      const { manager } = await dependencyFixture();
      const alternative = await fixture('1.0.0', { id: 'example.alternative', provides: ['example.provider'], configSchema: undefined });
      await manager.install(alternative.source);
      await manager.setEnabled('example.alternative', false);
      await expect(operation === 'remove' ? manager.remove('example.primary') : manager.setEnabled('example.primary', false)).rejects.toThrow('example.dependent');
    });

    it.each(['id', 'capability', 'reverse-id', 'reverse-capability'])('does not count an alternative with a %s conflict against the dependent', async conflict => {
      const reverse = conflict.startsWith('reverse');
      const capability = conflict.endsWith('capability');
      const { manager, configPath, marker } = await dependencyFixture('example.provider', 'example.primary', {
        provides: ['example.dependent-ready'],
        ...(reverse ? { conflicts: [capability ? 'example.alternative-ready' : 'example.alternative'] } : {}),
      });
      const alternative = await fixture('1.0.0', {
        id: 'example.alternative', provides: ['example.provider', 'example.alternative-ready'], configSchema: undefined,
        ...(!reverse ? { conflicts: [capability ? 'example.dependent-ready' : 'example.dependent'] } : {}),
      });
      await manager.install(alternative.source);
      const previous = await fs.readFile(configPath, 'utf8');
      await expect(operation === 'remove' ? manager.remove('example.primary') : manager.setEnabled('example.primary', false)).rejects.toThrow('example.dependent');
      expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
      expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
    });

    it('recognizes default builtin providers as alternatives', async () => {
      const { manager } = await dependencyFixture('context.provider');
      await expect(operation === 'remove' ? manager.remove('example.primary') : manager.setEnabled('example.primary', false)).resolves.toBeUndefined();
    });

    it('does not resurrect a builtin shadowed by an installed entry with the same id', async () => {
      const { manager } = await dependencyFixture('context.provider', 'context.code');
      await manager.setEnabled('context.retrieval', false, true);
      await manager.setEnabled('context.project-memory', false, true);
      await expect(operation === 'remove' ? manager.remove('context.code') : manager.setEnabled('context.code', false)).rejects.toThrow('example.dependent');
    });

    it.each(['record-json', 'manifest', 'config', 'missing-record', 'integrity'] as const)('fails safely on corrupt %s metadata and preserves settings', async corruption => {
      const { manager, homeDir, configPath } = await dependencyFixture();
      const secret = 'private-secret-value';
      const directory = join(homeDir, '.afk', 'plugins', 'example.dependent');
      const recordPath = join(directory, 'install.json');
      const record = (await readInstalledPlugin(directory))!;
      if (corruption === 'record-json') await fs.writeFile(recordPath, `{${secret}`);
      if (corruption === 'manifest') await fs.writeFile(recordPath, JSON.stringify({ ...record, manifest: { ...record.manifest, requires: [secret + '!'] } }));
      if (corruption === 'config') await fs.writeFile(configPath, `plugins: [${secret}`);
      if (corruption === 'missing-record') await fs.rm(recordPath);
      if (corruption === 'integrity') await fs.writeFile(join(directory, record.entry), secret);
      const previous = await fs.readFile(configPath, 'utf8');
      const error = await (operation === 'remove' ? manager.remove('example.primary') : manager.setEnabled('example.primary', false)).then(() => undefined, failure => failure as Error);
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).not.toContain(secret);
      expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
      expect(await readInstalledPlugin(join(homeDir, '.afk', 'plugins', 'example.primary'))).toBeDefined();
    });
  });

  it('protects the last builtin provider and accepts a real configured builtin alternative', async () => {
    const { manager, homeDir, configPath } = await dependencyFixture('notification.provider');
    await manager.setEnabled('example.primary', false);
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.setEnabled('notification.desktop', false, true)).rejects.toThrow('example.dependent');
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
    await manager.configure('notification.email', { from: 'from@example.test', to: 'to@example.test' }, true);
    await manager.setEnabled('notification.desktop', false, true);
    expect(readPluginConfiguration(homeDir).plugins.find(entry => entry.id === 'notification.desktop')?.enabled).toBe(false);
  });

  it('protects an exact configured credential provider even when the default keychain provides the capability', async () => {
    const { homeDir } = await fixture();
    const manager = new PluginManager({ homeDir });
    vi.stubEnv('AFK_TEST_WEBHOOK', 'https://hooks.example.test/private-webhook');
    const { EnterpriseCredentialProvider, SystemKeychainProvider } = await import('../../infrastructure/providers/credentials.js');
    const enterprise = vi.spyOn(EnterpriseCredentialProvider.prototype, 'resolve').mockRejectedValue(new Error('must not resolve credentials'));
    const keychain = vi.spyOn(SystemKeychainProvider.prototype, 'resolve').mockRejectedValue(new Error('must not resolve credentials'));
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not access the network'));
    await manager.configure('credential.enterprise', { values: { webhook: { env: 'AFK_TEST_WEBHOOK' } } }, true);
    await manager.configure('notification.slack', { webhook: { provider: 'credential.enterprise', name: 'webhook' } }, true);
    const configPath = join(homeDir, '.afk', 'plugins.yml');
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.setEnabled('credential.enterprise', false, true)).rejects.toThrow(/credential.enterprise.*notification.slack/);
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
    expect(enterprise).not.toHaveBeenCalled();
    expect(keychain).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    await manager.setEnabled('notification.slack', false, true);
    await expect(manager.setEnabled('credential.enterprise', false, true)).resolves.toBeUndefined();
  });

  it('does not infer credential references from arbitrary trigger payloads', async () => {
    const { homeDir } = await fixture();
    const manager = new PluginManager({ homeDir });
    vi.stubEnv('AFK_TEST_WEBHOOK', 'https://hooks.example.test/private-webhook');
    await manager.configure('credential.enterprise', { values: { webhook: { env: 'AFK_TEST_WEBHOOK' } } }, true);
    await manager.configure('trigger.issue-event', {
      triggers: [{ id: 'example', kind: 'webhook', payload: { provider: 'credential.enterprise', name: 'webhook' } }],
    }, true);
    await expect(manager.setEnabled('credential.enterprise', false, true)).resolves.toBeUndefined();
  });

  it('does not assume an installed credential plugin owns the configured builtin name it replaces', async () => {
    const { homeDir, source } = await fixture('1.0.0', { id: 'credential.enterprise', provides: ['credential.provider'], configSchema: undefined });
    const manager = new PluginManager({ homeDir });
    vi.stubEnv('AFK_TEST_WEBHOOK', 'https://hooks.example.test/private-webhook');
    await manager.configure('credential.enterprise', { values: { webhook: { env: 'AFK_TEST_WEBHOOK' } } }, true);
    await manager.configure('notification.slack', { webhook: { provider: 'credential.enterprise', name: 'webhook' } }, true);
    await expect(manager.install(source)).rejects.toThrow('notification.slack');
    expect(readPluginConfiguration(homeDir).plugins.find(entry => entry.id === 'credential.enterprise')?.builtin).toBe(true);
  });

  it.each(['disable', 'remove', 'replace', 'configure'])('conservatively protects opaque credential registration names during %s', async operation => {
    const provider = await fixture('1.0.0', { id: 'credential.late', provides: ['credential.provider'], configSchema: undefined });
    const other = await fixture('1.0.0', { id: 'credential.other', provides: ['credential.provider'], configSchema: undefined });
    const marker = join(provider.root, 'executed');
    await fs.writeFile(join(provider.source, 'dist', 'index.js'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); throw new Error('must not execute');`);
    const manager = new PluginManager({ homeDir: provider.homeDir });
    await manager.install(provider.source);
    await manager.install(other.source);
    await manager.configure('notification.slack', { webhook: { provider: 'late', name: 'webhook' } }, true);
    const configPath = join(provider.homeDir, '.afk', 'plugins.yml');
    const previous = await fs.readFile(configPath, 'utf8');
    const mutate = () => operation === 'configure' ? manager.configure('credential.late', { name: 'changed' }) : operation === 'replace' ? manager.install(provider.source) : operation === 'remove' ? manager.remove('credential.late') : manager.setEnabled('credential.late', false);
    await expect(mutate()).rejects.toThrow('notification.slack');
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
    expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
    await manager.setEnabled('notification.slack', false, true);
    await expect(mutate()).resolves.not.toThrow();
  });

  it('protects exact credential dependencies of another credential provider', async () => {
    const { homeDir } = await fixture();
    const manager = new PluginManager({ homeDir });
    vi.stubEnv('AFK_TEST_WEBHOOK', 'https://hooks.example.test/private-webhook');
    await manager.configure('credential.enterprise', { values: { webhook: { env: 'AFK_TEST_WEBHOOK' } } }, true);
    await manager.configure('credential.oauth', {
      tokenEndpoint: 'https://oauth.example.test/token', clientId: 'example', clientSecret: { provider: 'credential.enterprise', name: 'webhook' },
    }, true);
    await expect(manager.setEnabled('credential.enterprise', false, true)).rejects.toThrow('credential.oauth');
  });

  it('rejects unknown builtin ids instead of inferring capabilities from their prefix', async () => {
    const { manager, configPath } = await dependencyFixture('notification.provider');
    await manager.setEnabled('notification.desktop', false, true);
    await fs.appendFile(configPath, '\n  - id: notification.imaginary\n    builtin: true\n');
    await expect(manager.remove('example.primary')).rejects.toThrow(/metadata|builtin|configuration/i);
  });

  it('does not count a configurable builtin without a configuration as an alternative', async () => {
    const { manager, configPath } = await dependencyFixture('trigger.provider');
    await fs.appendFile(configPath, '\n  - id: trigger.git-push\n    builtin: true\n');
    await expect(manager.remove('example.primary')).rejects.toThrow();
  });

  it.each(['notification.imaginary', 'trigger.git-push'])('rejects enabling builtin %s without usable metadata', async id => {
    const { manager, configPath } = await dependencyFixture();
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.setEnabled(id, true, true)).rejects.toThrow(/metadata|configuration/i);
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
  });

  it('does not count an alternative that requires the capability it would have to bootstrap', async () => {
    const { manager, configPath } = await dependencyFixture();
    const alternative = await fixture('1.0.0', {
      id: 'example.circular', provides: ['example.provider'], requires: ['example.provider'], configSchema: undefined,
    });
    await manager.install(alternative.source);
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.remove('example.primary')).rejects.toThrow('example.dependent');
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
  });

  it('does not let an unrelated missing requirement block removing an unused capability', async () => {
    const { manager } = await dependencyFixture();
    const unrelated = await fixture('1.0.0', { id: 'example.unrelated', provides: [], requires: ['example.missing'], configSchema: undefined });
    await manager.install(unrelated.source);
    await manager.setEnabled('example.dependent', false);
    await expect(manager.remove('example.primary')).resolves.toBeUndefined();
  });

  it('allows an alternative whose requirements are supplied by default workflow metadata', async () => {
    const { manager } = await dependencyFixture();
    const alternative = await fixture('1.0.0', {
      id: 'example.actions', provides: ['example.provider'], requires: ['workflow.action'], configSchema: undefined,
    });
    await manager.install(alternative.source);
    await expect(manager.remove('example.primary')).resolves.toBeUndefined();
  });

  it('recognizes a validated conditional builtin lifecycle as an alternative', async () => {
    const { manager, homeDir, configPath } = await dependencyFixture('workflow.lifecycle');
    const configuration = readPluginConfiguration(homeDir);
    await fs.writeFile(configPath, JSON.stringify({ ...configuration, integrations: {} }));
    await expect(manager.remove('example.primary')).resolves.toBeUndefined();
  });

  it('rejects malformed lifecycle configuration without disclosing its values', async () => {
    const { manager, homeDir, configPath } = await dependencyFixture();
    const configuration = readPluginConfiguration(homeDir);
    const secret = 'private-integration-secret';
    const previous = JSON.stringify({ ...configuration, integrations: { notifications: [{ provider: 1, message: { title: secret, body: secret } }] } });
    await fs.writeFile(configPath, previous);
    const error = await manager.remove('example.primary').then(() => undefined, failure => failure as Error);
    expect(error?.message).toMatch(/configuration/i);
    expect(error?.message).not.toContain(secret);
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
  });

  it.each([undefined, {}, { contexts: [{ provider: 'context.code', query: { scope: '.', prompt: 'inspect' } }] }])('keeps builtin metadata aligned with default composition without activation during inspection (%j)', async integrations => {
    const { homeDir, root } = await fixture();
    const { builtinPluginManifests } = await import('./builtin-manifests.js');
    const activate = vi.spyOn(PluginRuntime.prototype, 'activate');
    const manifests = builtinPluginManifests(homeDir, integrations);
    expect(activate).not.toHaveBeenCalled();
    activate.mockRestore();
    const { createDefaultPluginRuntime } = await import('./default-runtime.js');
    await fs.mkdir(join(homeDir, '.afk'), { recursive: true });
    await fs.writeFile(join(homeDir, '.afk', 'plugins.yml'), JSON.stringify({ integrations }));
    const runtime = await createDefaultPluginRuntime({ homeDir, workspaceRoot: root });
    try {
      const byId = (left: PluginManifest, right: PluginManifest) => left.id.localeCompare(right.id);
      expect([...manifests].sort(byId)).toEqual(runtime.listPlugins().map(id => runtime.getPlugin(id)!.manifest).sort(byId));
    } finally { await runtime.dispose(); }
  });

  it('keeps builtin selection when an installed copy has the same id', async () => {
    const { source, homeDir } = await fixture('1.0.0', { id: 'notification.desktop', provides: ['example.provider'], configSchema: { type: 'object', additionalProperties: false } });
    const manager = new PluginManager({ homeDir });
    await manager.install(source);
    await manager.configure('notification.desktop', { channel: 'selected' }, true);
    await manager.setEnabled('notification.desktop', false, true);
    await manager.setEnabled('notification.desktop', true, true);
    expect(readPluginConfiguration(homeDir).plugins[0].builtin).toBe(true);
  });

  it('preserves an installation when an upgrade drops a required capability', async () => {
    const { manager, source, homeDir, configPath } = await dependencyFixture();
    const previous = await fs.readFile(configPath, 'utf8');
    const manifest = JSON.parse(await fs.readFile(join(source, 'plugin.json'), 'utf8'));
    await fs.writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, version: '2.0.0', provides: [] }));
    await expect(manager.install(source)).rejects.toThrow('example.dependent');
    expect((await readInstalledPlugin(join(homeDir, '.afk', 'plugins', 'example.primary')))?.version).toBe('1.0.0');
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
  });

  it('repairs a changed installed entry using a validated replacement without executing plugins', async () => {
    const { manager, homeDir, source, marker } = await dependencyFixture();
    const directory = join(homeDir, '.afk', 'plugins', 'example.primary');
    const record = (await readInstalledPlugin(directory))!;
    await fs.writeFile(join(directory, record.entry), 'throw new Error("damaged entry must not execute");');
    await expect(manager.install(source)).resolves.toMatchObject({ id: 'example.primary', version: '1.0.0' });
    expect(await fs.readFile(join(directory, record.entry), 'utf8')).toBe(await fs.readFile(join(source, 'dist', 'index.js'), 'utf8'));
    expect(readPluginConfiguration(homeDir).plugins.find(entry => entry.id === 'example.dependent')?.enabled).toBe(true);
    expect(await fs.stat(marker).then(() => true, () => false)).toBe(false);
  });

  it('does not ignore another damaged plugin while repairing the target entry', async () => {
    const { manager, homeDir, source, configPath } = await dependencyFixture();
    const directory = join(homeDir, '.afk', 'plugins', 'example.primary');
    const record = (await readInstalledPlugin(directory))!;
    const damaged = 'throw new Error("damaged entry");';
    await fs.writeFile(join(directory, record.entry), damaged);
    await fs.writeFile(join(homeDir, '.afk', 'plugins', 'example.dependent', 'install.json'), '{private-secret');
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.install(source)).rejects.toThrow('example.dependent');
    expect(await fs.readFile(join(directory, record.entry), 'utf8')).toBe(damaged);
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
  });

  it('still protects existing dependents when repairing an entry with fewer capabilities', async () => {
    const { manager, homeDir, source, configPath } = await dependencyFixture();
    const directory = join(homeDir, '.afk', 'plugins', 'example.primary');
    const record = (await readInstalledPlugin(directory))!;
    await fs.writeFile(join(directory, record.entry), 'throw new Error("damaged entry");');
    await fs.writeFile(join(source, 'plugin.json'), JSON.stringify({ ...record.manifest, version: '2.0.0', provides: [] }));
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.install(source)).rejects.toThrow('example.dependent');
    expect((await readInstalledPlugin(directory))?.version).toBe('1.0.0');
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
  });

  it.each([false, true])('allows two newly installed plugins to be configured independently (reverse: %s)', async reverse => {
    const first = await fixture('1.0.0', { id: 'example.first', provides: ['example.first-capability'] });
    const second = await fixture('1.0.0', { id: 'example.second', provides: ['example.second-capability'] });
    const manager = new PluginManager({ homeDir: first.homeDir });
    await manager.install(first.source);
    await manager.install(second.source);
    const ids = reverse ? ['example.second', 'example.first'] : ['example.first', 'example.second'];
    for (const id of ids) await expect(manager.configure(id, { scope: id })).resolves.toBeUndefined();
    expect(readPluginConfiguration(first.homeDir).plugins.map(entry => entry.config?.scope)).toEqual(ids);
  });

  it.each(['disable', 'remove'])('allows %s without being blocked by another unconfigured plugin', async operation => {
    const first = await fixture('1.0.0', { id: 'example.first' });
    const second = await fixture('1.0.0', { id: 'example.second' });
    const manager = new PluginManager({ homeDir: first.homeDir });
    await manager.install(first.source);
    await manager.install(second.source);
    await expect(operation === 'remove' ? manager.remove('example.first') : manager.setEnabled('example.first', false)).resolves.toBeUndefined();
    await expect(manager.configure('example.second', { scope: 'ready' })).resolves.toBeUndefined();
  });

  it('requires configuration before enabling a newly installed plugin', async () => {
    const { source, homeDir } = await fixture();
    const manager = new PluginManager({ homeDir });
    await manager.install(source);
    await manager.setEnabled('context.example', false);
    await expect(manager.setEnabled('context.example', true)).rejects.toThrow('Invalid plugin settings');
    expect(readPluginConfiguration(homeDir).plugins[0].enabled).toBe(false);
    await manager.configure('context.example', { scope: 'ready' });
    await expect(manager.setEnabled('context.example', true)).resolves.toBeUndefined();
  });

  it('does not protect an already unconfigured dependent', async () => {
    const { manager } = await dependencyFixture('example.provider', 'example.primary', {
      configSchema: { type: 'object', required: ['scope'] },
    });
    await expect(manager.remove('example.primary')).resolves.toBeUndefined();
  });

  it('protects a working dependent despite an unrelated unconfigured plugin', async () => {
    const { manager, configPath } = await dependencyFixture();
    const unrelated = await fixture('1.0.0', { id: 'example.unconfigured' });
    await manager.install(unrelated.source);
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.remove('example.primary')).rejects.toThrow('example.dependent');
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
  });

  it.each(['toggle', 'reinstall'])('preserves configured plugin order during %s', async operation => {
    const { manager, homeDir, source } = await dependencyFixture();
    const ids = readPluginConfiguration(homeDir).plugins.map(entry => entry.id);
    if (operation === 'toggle') {
      await manager.setEnabled('example.dependent', false);
      await manager.setEnabled('example.primary', false);
    } else await manager.install(source);
    expect(readPluginConfiguration(homeDir).plugins.map(entry => entry.id)).toEqual(ids);
  });

  it('validates persisted settings before upgrading or enabling an installed plugin', async () => {
    const { manager, source, homeDir, configPath } = await dependencyFixture();
    await manager.configure('example.primary', { scope: 'original' });
    const manifest = JSON.parse(await fs.readFile(join(source, 'plugin.json'), 'utf8'));
    await fs.writeFile(join(source, 'plugin.json'), JSON.stringify({ ...manifest, version: '2.0.0', configSchema: { type: 'object', properties: { scope: { type: 'number' } } } }));
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.install(source)).rejects.toThrow(/settings|configuration/i);
    expect((await readInstalledPlugin(join(homeDir, '.afk', 'plugins', 'example.primary')))?.version).toBe('1.0.0');
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
    await manager.setEnabled('example.dependent', false);
    await manager.setEnabled('example.primary', false);
    const recordPath = join(homeDir, '.afk', 'plugins', 'example.primary', 'install.json');
    const record = (await readInstalledPlugin(join(homeDir, '.afk', 'plugins', 'example.primary')))!;
    await fs.writeFile(recordPath, JSON.stringify({ ...record, manifest: { ...record.manifest, configSchema: { type: 'object', properties: { scope: { type: 'number' } } } } }));
    await expect(manager.setEnabled('example.primary', true)).rejects.toThrow(/settings|configuration/i);
  });

  it('protects dependencies when configure switches an installed plugin to a builtin with different capabilities', async () => {
    const { manager, configPath } = await dependencyFixture('example.provider', 'notification.desktop');
    const previous = await fs.readFile(configPath, 'utf8');
    await expect(manager.configure('notification.desktop', {}, true)).rejects.toThrow('example.dependent');
    expect(await fs.readFile(configPath, 'utf8')).toBe(previous);
  });

  it('validates bundled provider settings before replacing the persisted configuration', async () => {
    const { homeDir } = await fixture();
    const manager = new PluginManager({ homeDir });
    await expect(manager.configure('notification.slack', {}, true)).rejects.toThrow();
    expect(readPluginConfiguration(homeDir).plugins).toEqual([]);
  });
  it('installs, configures, loads, disables, and removes an isolated plugin', async () => {
    const { source, homeDir } = await fixture();
    const npm = vi.fn();
    const manager = new PluginManager({ homeDir, runNpm: npm });
    await manager.setEnabled('context.example', false, true);
    const installed = await manager.install(source);
    expect(installed.id).toBe('context.example');
    expect(npm).not.toHaveBeenCalled();
    expect(readPluginConfiguration(homeDir).plugins[0].builtin).toBe(false);
    await manager.configure(installed.id, { scope: 'project' });
    const runtime = new PluginRuntime();
    expect(await loadInstalledPlugins(runtime, { homeDir })).toEqual([installed.id]);
    expect(await runtime.getContextProvider('example')!.gather({ scope: 'project', prompt: 'q' })).toEqual([{ origin: 'project', content: 'ready' }]);
    await manager.setEnabled(installed.id, false);
    expect(await loadInstalledPlugins(new PluginRuntime(), { homeDir })).toEqual([]);
    await manager.remove(installed.id);
    expect(await readInstalledPlugin(join(homeDir, '.afk', 'plugins', installed.id))).toBeUndefined();
    expect(readPluginConfiguration(homeDir).plugins[0].enabled).toBe(false);
  });

  it('keeps the previous plugin and settings when dependencies or settings fail', async () => {
    const { source, homeDir } = await fixture();
    const npm = vi.fn(async () => { throw new Error('npm failed'); });
    const manager = new PluginManager({ homeDir, runNpm: npm });
    await manager.install(source);
    await manager.configure('context.example', { scope: 'original' });
    await fs.writeFile(join(source, 'package.json'), '{"type":"module","dependencies":{"example":"1.0.0"}}');
    await expect(manager.install(source)).rejects.toThrow('npm failed');
    expect((await readInstalledPlugin(join(homeDir, '.afk', 'plugins', 'context.example')))?.version).toBe('1.0.0');
    await expect(manager.configure('context.example', { scope: 1 })).rejects.toThrow('Invalid plugin settings');
    expect(readPluginConfiguration(homeDir).plugins[0].config).toEqual({ scope: 'original' });
    expect(npm.mock.calls[0][0]).toContain('--ignore-scripts');
  });

  it('installs and resolves a real local npm dependency without executing install scripts', async () => {
    const { source, homeDir, root } = await fixture();
    const dependency = join(root, 'dependency');
    await fs.mkdir(dependency);
    await fs.writeFile(join(dependency, 'package.json'), JSON.stringify({ name: 'fixture-context-dependency', version: '1.0.0', type: 'module', main: 'index.js', scripts: { postinstall: 'node -e "process.exit(42)"' } }));
    await fs.writeFile(join(dependency, 'index.js'), 'export default "dependency installed";');
    await fs.writeFile(join(source, 'package.json'), JSON.stringify({ name: 'context-example', type: 'module', dependencies: { 'fixture-context-dependency': `file:${dependency}` } }));
    const entry = join(source, 'dist', 'index.js');
    const original = await fs.readFile(entry, 'utf8');
    await fs.writeFile(entry, `import helper from 'fixture-context-dependency';\n${original.replace("content: 'ready'", 'content: helper')}`);
    const manager = new PluginManager({ homeDir });
    await manager.install(source);
    await manager.configure('context.example', { scope: 'npm' });
    const runtime = new PluginRuntime();
    await loadInstalledPlugins(runtime, { homeDir });
    expect(await runtime.getContextProvider('example')!.gather({ scope: 'npm', prompt: 'q' })).toEqual([{ origin: 'npm', content: 'dependency installed' }]);
  }, 30_000);

  it('rejects traversal, changed entry points, and concurrent manager writes', async () => {
    const { source, homeDir } = await fixture();
    const manager = new PluginManager({ homeDir });
    await expect(manager.setEnabled('../bad', false)).rejects.toThrow('invalid plugin id');
    await manager.install(source);
    await fs.writeFile(join(homeDir, '.afk', 'plugins', 'context.example', 'package', 'dist', 'index.js'), 'throw new Error("should not execute")');
    const runtime = new PluginRuntime();
    expect(await loadInstalledPlugins(runtime, { homeDir })).toEqual([]);
    expect(await runtime.diagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'load.failed', message: expect.stringContaining('integrity') })]));
    await fs.writeFile(join(homeDir, '.afk', 'plugins', '.manager.lock'), '');
    await expect(manager.remove('context.example')).rejects.toThrow('Another plugin operation');
  });
});
