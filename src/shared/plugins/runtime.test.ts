import { describe, expect, it } from 'vitest';
import { PluginRuntime, type WorkflowPlugin } from '../../application/plugins/runtime';
import type { BacklogProvider } from '../../domain/backlog/index';

describe('workflow plugin runtime', () => {
  it('registers typed capabilities through the setup context', async () => {
    const runtime = new PluginRuntime();
    const plugin: WorkflowPlugin = {
      id: 'acme.audit',
      version: '1.0.0',
      setup(ctx) {
        ctx.lifecycle({ name: 'audit', onRunStart: async () => {} });
        ctx.systemAction('audit-report', async () => ({ ok: true }));
      },
    };

    await runtime.load(plugin);

    expect(runtime.listPlugins()).toEqual(['acme.audit']);
    expect(runtime.getLifecycleModules()).toHaveLength(1);
    expect(await runtime.dispatchSystemAction('audit-report', {})).toEqual({ ok: true });
  });

  it('registers a provider-native backlog capability for atomic claims', async () => {
    const runtime = new PluginRuntime();
    const provider = { claim: async () => null } as unknown as BacklogProvider;
    await runtime.load({
      id: 'acme.backlog',
      version: '1.0.0',
      setup(ctx) { ctx.backlogProvider('acme', provider); },
    });

    expect(runtime.getBacklogProvider('acme')).toBe(provider);
    expect(runtime.listBacklogProviders()).toEqual(['acme']);
  });

  it('rejects duplicate plugin ids and unknown system actions', async () => {
    const runtime = new PluginRuntime();
    const plugin: WorkflowPlugin = { id: 'acme.audit', version: '1.0.0', setup() {} };
    await runtime.load(plugin);
    await expect(runtime.load(plugin)).rejects.toThrow(/already loaded/);
    await expect(runtime.dispatchSystemAction('missing', {})).rejects.toThrow(/unknown system action/);
  });

  it('isolates plugin failures and supports explicit teardown', async () => {
    const runtime = new PluginRuntime();
    const dispose = async () => {};
    await runtime.load({ id: 'acme.cleanup', version: '1.0.0', setup(ctx) { ctx.dispose(dispose); } });
    await runtime.close();
    expect(runtime.listPlugins()).toEqual([]);
  });
});
