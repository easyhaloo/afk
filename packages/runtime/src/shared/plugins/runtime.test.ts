import { describe, expect, it, vi } from 'vitest';
import { PluginRuntime, type WorkflowPlugin } from '../../application/plugins/runtime.js';
import type { BacklogProvider } from '../../domain/backlog/index.js';
import type { IssueTrackerPort } from '../../plugin-sdk/issue-tracker.js';

describe('workflow plugin runtime', () => {
  it('lets a dependent plugin resolve credentials privately through its setup context', async () => {
    const runtime = new PluginRuntime();
    const resolve = vi.fn(async () => ({ secret: 'fixture-private-token' }));
    await runtime.activate({
      manifest: { id: 'credential.fixture', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['credential.provider'] },
      activate(context) { context.registerCredentialProvider('fixture', { id: 'fixture', capabilities: { read: true, rotate: false, 'scoped-token': true }, resolve }); },
    });
    await runtime.activate({
      manifest: { id: 'host.fixture', version: '1.0.0', apiVersion: 1, trusted: true, provides: [], requires: ['credential.provider'] },
      async activate(context) {
        expect(context.getProvider('credential.provider', 'fixture')).toBe(context.getCredentialProvider('fixture'));
        expect(await context.getCredentialProvider('fixture')!.resolve({ name: 'connection', scope: 'host:read' })).toEqual({ secret: 'fixture-private-token' });
      },
    });
    expect(resolve).toHaveBeenCalledWith({ name: 'connection', scope: 'host:read' });
    await expect(runtime.dispose('credential.fixture')).rejects.toThrow();
    await runtime.dispose();
  });
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

  it('registers a shared host provider for desktop and CLI callers', async () => {
    const runtime = new PluginRuntime();
    const provider = {
      listHosts: async () => [],
      resolve: async () => ({ id: 'host-1', alias: 'demo', provider: 'ssh' }),
      exec: async () => ({ code: 0, stdout: '', stderr: '' }),
    };
    await runtime.load({ id: 'host.ssh', version: '1.0.0', setup: context => context.hostProvider('ssh', provider) });

    expect(runtime.listHostProviders()).toEqual(['ssh']);
    expect(runtime.getHostProvider('ssh')).toBe(provider);
  });

  it('registers an issue tracker through its dedicated port', async () => {
    const runtime = new PluginRuntime();
    const provider = { id: 'linear', projectId: 'team-1', baseUrl: 'https://linear.example' } as IssueTrackerPort;
    await runtime.activate({
      manifest: { id: 'tracker.linear', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['tracker.issue'] },
      activate: context => context.registerIssueTrackerProvider(provider.id, provider),
    });

    expect(runtime.listIssueTrackerProviders()).toEqual(['linear']);
    expect(runtime.getIssueTrackerProvider('linear')).toBe(provider);
  });

  it('projects registered agent providers into the execution registry', async () => {
    const runtime = new PluginRuntime();
    const provider = { name: 'custom-agent', capabilities: new Set(), createExecution: vi.fn() };
    await runtime.load({ id: 'agent.custom', version: '1.0.0', setup: context => context.agentProvider('custom-agent', provider as never) });

    expect(runtime.getAgentProviderRegistry().require('custom-agent')).toBe(provider);
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

  it('commits all declared capability registrations atomically', async () => {
    const runtime = new PluginRuntime();
    await runtime.activate({
      manifest: {
        id: 'platform.adapters', version: '1.0.0', apiVersion: 1, trusted: true,
        provides: ['agent.provider', 'sandbox.provider', 'tracker.provider', 'backlog.provider', 'host.connection', 'verification.provider',
          'notification.provider', 'trigger.provider', 'context.provider', 'credential.provider', 'artifact.provider',
          'repository.provider', 'policy.provider', 'observability.provider', 'surface.cli', 'surface.tui', 'surface.desktop'],
      },
      activate(ctx) {
        const provider = {};
        ctx.registerAgentProvider('codex', provider as never);
        ctx.registerSandboxProvider('local', provider as never);
        ctx.registerTrackerProvider('github', provider as never);
        ctx.registerBacklogProvider('github', provider as never);
        ctx.registerHostProvider('ssh', provider as never);
        ctx.registerVerificationProvider('default', provider);
        ctx.registerNotificationProvider('desktop', provider);
        ctx.registerTriggerProvider('webhook', provider);
        ctx.registerContextProvider('project', provider);
        ctx.registerCredentialProvider('keychain', provider);
        ctx.registerArtifactProvider('filesystem', provider);
        ctx.registerRepositoryProvider('git', provider);
        ctx.registerPolicyProvider('default', provider);
        ctx.registerObservabilityProvider('jsonl', provider);
        ctx.registerCliSurface('commands', provider);
        ctx.registerTuiSurface('panels', provider);
        ctx.registerDesktopSurface('views', provider);
      },
    });

    expect(runtime.listCapabilities()).toEqual(expect.arrayContaining([
      'agent.provider', 'sandbox.provider', 'tracker.provider', 'host.connection', 'verification.provider',
      'notification.provider', 'trigger.provider', 'context.provider', 'credential.provider', 'artifact.provider',
      'repository.provider', 'policy.provider', 'observability.provider', 'surface.cli', 'surface.tui', 'surface.desktop',
    ]));
    expect(runtime.getProvider('notification.provider', 'desktop')).toBeDefined();
  });

  it('rolls back staged registrations and disposers when activation fails', async () => {
    const runtime = new PluginRuntime();
    const dispose = vi.fn(async () => {});
    await expect(runtime.activate({
      manifest: { id: 'broken.plugin', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['host.connection'] },
      activate(ctx) {
        ctx.registerHostProvider('ssh', {});
        ctx.onDispose(dispose);
        throw new Error('activate failed');
      },
    })).rejects.toThrow('activate failed');
    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.listPlugins()).toEqual([]);
    expect(runtime.listProviders('host.connection')).toEqual([]);
    await expect(runtime.diagnostics('broken.plugin')).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'activation.failed' }),
    ]));
  });

  it('allows multiple named providers while rejecting missing dependencies and conflicts', async () => {
    const runtime = new PluginRuntime();
    await expect(runtime.activate({
      manifest: { id: 'agent.codex', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['agent.provider'] },
      activate() {},
    })).resolves.toBeUndefined();
    await expect(runtime.activate({
      manifest: { id: 'agent.other', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['agent.provider'] },
      activate(context) { context.registerAgentProvider('other', { name: 'other', capabilities: new Set(), createExecution: vi.fn() }); },
    })).resolves.toBeUndefined();
    expect(runtime.listProviders('agent.provider')).toEqual(['other']);
    await runtime.dispose('agent.codex');
    expect(runtime.listCapabilities()).toContain('agent.provider');
    await expect(runtime.activate({
      manifest: { id: 'host.jumpserver', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['host.connection'], requires: ['credential.provider'] },
      activate() {},
    })).rejects.toThrow(/requires missing/);
  });

  it('reports provider health and captures diagnostic failures', async () => {
    const runtime = new PluginRuntime();
    await runtime.activate({
      manifest: { id: 'observe.health', version: '1.0.0', apiVersion: 1, trusted: true, provides: [] },
      activate() {},
      health: async () => ({ status: 'degraded', message: 'slow' }),
      diagnostics: async () => { throw new Error('diagnostic failed'); },
    });
    await expect(runtime.health()).resolves.toEqual([{ pluginId: 'observe.health', status: 'degraded', message: 'slow' }]);
    await expect(runtime.diagnostics()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'diagnostics.failed', message: 'diagnostic failed' }),
    ]));
  });

  it('rejects undeclared registrations and conflicts in either activation order', async () => {
    const runtime = new PluginRuntime();
    await expect(runtime.activate({
      manifest: { id: 'test.undeclared', version: '1.0.0', apiVersion: 1, trusted: true, provides: [] },
      activate(context) { context.registerCapability('context.provider', 'context', {}); },
    })).rejects.toThrow('undeclared capability');
    expect(runtime.listProviders('context.provider')).toEqual([]);
    await runtime.activate({
      manifest: { id: 'test.first', version: '1.0.0', apiVersion: 1, trusted: true, provides: [], conflicts: ['test.second'] },
      activate() {},
    });
    await expect(runtime.activate({
      manifest: { id: 'test.second', version: '1.0.0', apiVersion: 1, trusted: true, provides: [] }, activate() {},
    })).rejects.toThrow('conflicts with');
  });
});
