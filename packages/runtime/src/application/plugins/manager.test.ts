import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginManager, readInstalledPlugin } from './manager.js';
import { readPluginConfiguration } from './configuration.js';
import { loadInstalledPlugins } from './loader.js';
import { PluginRuntime } from './runtime.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

async function fixture(version = '1.0.0') {
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

describe('PluginManager', () => {
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
