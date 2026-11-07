import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { PluginRuntime } from './runtime.js';
import { loadInstalledPlugins } from './loader.js';
import { createConfiguredPlugins } from './configured.js';

describe('loadInstalledPlugins', () => {
  it.each(['resolution', 'activation'])('does not retry a configured consumer after an actual %s failure while other plugins progress', async failure => {
    const runtime = new PluginRuntime();
    const resolve = vi.fn(async () => {
      if (failure === 'resolution') throw new Error('synthetic resolution failure');
      return { secret: 'https://webhook.example.test/fixture' };
    });
    const [consumer] = await createConfiguredPlugins({ configurations: [
      { id: 'notification.slack', config: { webhook: { provider: 'fixture', name: 'webhook' } } },
    ] });
    const activate = vi.spyOn(consumer, 'activate');
    try {
      const loaded = await loadInstalledPlugins(runtime, { entries: [], plugins: [
        consumer,
        { manifest: { id: 'test.final', version: '1.0.0', apiVersion: 1, trusted: true, provides: [], requires: ['test.progress'] }, activate() {} },
        { manifest: { id: 'test.progress', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['test.progress'], requires: ['credential.provider'] }, activate() {} },
        {
          manifest: { id: 'credential.fixture', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['credential.provider', 'notification.provider'] },
          activate(context) {
            context.registerCredentialProvider('fixture', { id: 'fixture', capabilities: { read: true, rotate: false, 'scoped-token': false }, resolve });
            if (failure === 'activation') context.registerNotificationProvider('notification.slack', { id: 'notification.slack', capabilities: { 'direct-message': false, 'channel-post': true, mention: false }, async notify() { return { delivered: true, channel: 'fixture' }; } });
          },
        },
      ] });
      expect(loaded).toEqual(['credential.fixture', 'test.progress', 'test.final']);
      expect(activate).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(runtime.getPlugin('notification.slack')).toBeUndefined();
      const errors = (await runtime.diagnostics()).filter(item => item.pluginId === 'notification.slack');
      expect(errors.map(item => item.code)).toEqual(['activation.failed', 'load.failed']);
      expect(errors[0].message).toContain(failure === 'resolution' ? 'credential resolution failed' : 'duplicate notification.provider');
    } finally { await runtime.dispose(); }
  });

  it('never falls back to a builtin when an explicitly selected installed override is missing', async () => {
    const runtime = new PluginRuntime();
    const activate = vi.fn();
    await loadInstalledPlugins(runtime, {
      homeDir: join(tmpdir(), 'missing-override'), entries: [{ id: 'policy.license-policy', enabled: true }],
      plugins: [{ manifest: { id: 'policy.license-policy', version: '0.1.0', apiVersion: 1, trusted: true, provides: ['policy.provider'] }, activate }],
    });
    expect(activate).not.toHaveBeenCalled();
    expect(runtime.getPlugin('policy.license-policy')).toBeUndefined();
    expect((await runtime.diagnostics()).some(diagnostic => diagnostic.code === 'load.missing')).toBe(true);
  });
  it('loads enabled local plugins from the shared AFK config', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'afk-plugin-'));
    const entryDir = join(homeDir, '.afk', 'plugins', 'host.ssh', 'dist');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(homeDir, '.afk', 'plugins.yml'), 'plugins:\n  - id: host.ssh\n');
    writeFileSync(join(entryDir, 'index.mjs'), "export default { id: 'host.ssh', version: '1.0.0', setup(ctx) { ctx.hostProvider('ssh', { listHosts: async () => [], resolve: async () => ({ id: '1', alias: 'demo', provider: 'ssh' }), exec: async () => ({ code: 0, stdout: '', stderr: '' }) }); } }");
    const warn = vi.fn();
    const runtime = new PluginRuntime();

    try {
      await expect(loadInstalledPlugins(runtime, {
        homeDir,
        resolveEntry: (_home, id) => join(homeDir, '.afk', 'plugins', id, 'dist', 'index.mjs'),
        warn,
      })).resolves.toEqual(['host.ssh']);
      expect(runtime.listHostProviders()).toEqual(['ssh']);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('loads the manifest based plugin protocol', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'plugin-'));
    const entryDir = join(homeDir, '.afk', 'plugins', 'agent.codex', 'dist');
    mkdirSync(entryDir, { recursive: true });
    writeFileSync(join(homeDir, '.afk', 'plugins.yml'), 'plugins:\n  - id: agent.codex\n');
    writeFileSync(join(entryDir, 'index.mjs'), "export default { manifest: { id: 'agent.codex', version: '1.0.0', apiVersion: 1, provides: ['agent.provider'], trusted: true }, activate(ctx) { ctx.registerAgentProvider('codex', {}); } }");
    const runtime = new PluginRuntime();

    try {
      await expect(loadInstalledPlugins(runtime, {
        homeDir,
        resolveEntry: (_home, id) => join(homeDir, '.afk', 'plugins', id, 'dist', 'index.mjs'),
      })).resolves.toEqual(['agent.codex']);
      expect(runtime.listProviders('agent.provider')).toEqual(['codex']);
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('records diagnostics for missing and duplicate entries', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'plugin-diagnostics-'));
    mkdirSync(join(homeDir, '.afk'), { recursive: true });
    writeFileSync(join(homeDir, '.afk', 'plugins.yml'), 'plugins:\n  - id: host.missing\n  - id: host.missing\n');
    const runtime = new PluginRuntime();
    try {
      await loadInstalledPlugins(runtime, { homeDir });
      await expect(runtime.diagnostics()).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ pluginId: 'host.missing', code: 'load.missing' }),
        expect.objectContaining({ pluginId: 'host.missing', code: 'config.duplicate' }),
      ]));
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });

  it('orders providers before dependents and reports unresolved cycles', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'plugin-order-'));
    const runtime = new PluginRuntime();
    const order: string[] = [];
    try {
      const loaded = await loadInstalledPlugins(runtime, { homeDir, plugins: [
        { manifest: { id: 'test.consumer', version: '1.0.0', apiVersion: 1, trusted: true, provides: [], requires: ['context.provider'] }, activate() { order.push('consumer'); } },
        { manifest: { id: 'test.provider', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['context.provider'] }, activate() { order.push('provider'); } },
        { manifest: { id: 'test.cycle', version: '1.0.0', apiVersion: 1, trusted: true, provides: [], requires: ['missing.provider'] }, activate() { throw new Error('must not run'); } },
      ] });
      expect(loaded).toEqual(['test.provider', 'test.consumer']);
      expect(order).toEqual(['provider', 'consumer']);
      expect(await runtime.diagnostics()).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'load.dependencies' })]));
    } finally { rmSync(homeDir, { recursive: true, force: true }); }
  });
});
