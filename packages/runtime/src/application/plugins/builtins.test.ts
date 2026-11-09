import { describe, expect, it, vi } from 'vitest';
import { createBuiltinCapabilityPlugins } from './builtin-capabilities.js';
import { createBuiltinAgentPlugins, createBuiltinSandboxPlugins, createBuiltinVerificationPlugins } from './builtin-providers.js';
import { WorktreeManager } from '../../infrastructure/git/worktree.js';
import type { NotificationProvider } from '../../plugin-sdk/capabilities.js';
import { createJumpserverPlugin } from './builtins.js';
import { PluginRuntime } from './runtime.js';

describe('built-in plugins', () => {
  it('registers JumpServer as a host provider and reports missing binaries', async () => {
    const resolveBinaryPath = vi.fn(async () => '');
    const runtime = new PluginRuntime();
    await runtime.activate(createJumpserverPlugin({ cli: {
      resolveBinaryPath,
      listServers: async () => [],
      listAssets: async () => [],
      execAssetCommand: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
      uploadFile: async () => ({ ok: true, stdout: '', stderr: '', code: 0 }),
    } as never }));
    expect(runtime.listHostProviders()).toEqual(['jumpserver']);
    await expect(runtime.health('host.jumpserver')).resolves.toEqual([{
      pluginId: 'host.jumpserver',
      status: 'degraded',
      message: 'jms CLI not found on PATH',
    }]);
    expect(resolveBinaryPath).toHaveBeenCalledOnce();
  });

  it('projects the built-in agent, sandbox, and verification providers', async () => {
    const runtime = new PluginRuntime();
    const plugins = [
      ...createBuiltinAgentPlugins(),
      ...createBuiltinSandboxPlugins({ worktreeManager: new WorktreeManager() }),
      ...createBuiltinVerificationPlugins(),
    ];
    for (const plugin of plugins) await runtime.activate(plugin);

    expect(runtime.listProviders('agent.provider')).toEqual(['claude-code', 'codex', 'cursor', 'pi', 'opencode', 'copilot']);
    expect(runtime.listProviders('sandbox.provider')).toEqual(['local', 'docker', 'podman']);
    expect(runtime.listProviders('verification.provider')).toEqual(['test-runner', 'static-scan', 'browser-check']);
  });

  it('projects a concrete cross-domain provider through the generic plugin factory', async () => {
    const runtime = new PluginRuntime();
    const notification: NotificationProvider = {
      id: 'test-notification',
      capabilities: { 'direct-message': true, 'channel-post': false, mention: false },
      notify: async () => ({ delivered: true, channel: 'default' }),
    };

    for (const plugin of createBuiltinCapabilityPlugins({ notifications: [notification] })) {
      await runtime.activate(plugin);
    }

    expect(runtime.getNotificationProvider('test-notification')).toBe(notification);
    expect(runtime.listProvidersForPlugin('notification.test-notification')).toEqual(['test-notification']);
  });
});
