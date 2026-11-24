import { describe, expect, it, vi } from 'vitest';
import { createBuiltinCapabilityPlugins } from './builtin-capabilities.js';
import { createBuiltinAgentPlugins, createBuiltinSandboxPlugins, createBuiltinVerificationPlugins } from './builtin-providers.js';
import { WorktreeManager } from '../../infrastructure/git/worktree.js';
import type { NotificationProvider } from '../../plugin-sdk/capabilities.js';
import { createJumpserverPlugin } from './builtins.js';
import { PluginRuntime } from './runtime.js';

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile,
}));

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

  it('probes the built-in agent executables only when checking health', async () => {
    execFile.mockReset();
    execFile.mockImplementation((_binary, _argv, _options, callback) => callback(null));
    const runtime = new PluginRuntime();
    for (const plugin of createBuiltinAgentPlugins()) await runtime.activate(plugin);
    expect(execFile).not.toHaveBeenCalled();

    const health = await runtime.health();
    expect(health.map(entry => entry.status)).toEqual(Array(6).fill('healthy'));
    expect(execFile.mock.calls.map(([binary, argv]) => [binary, argv])).toEqual(
      ['claude', 'codex', 'cursor-agent', 'pi', 'opencode', 'copilot'].map(binary => [binary, ['--version']]),
    );
  });

  it('distinguishes a missing agent CLI from a failed version check without exposing process output', async () => {
    execFile.mockReset();
    execFile.mockImplementationOnce((_binary, _argv, _options, callback) => callback({ code: 'ENOENT' }));
    execFile.mockImplementationOnce((_binary, _argv, _options, callback) => callback(new Error('private output')));
    const runtime = new PluginRuntime();
    await runtime.activate(createBuiltinAgentPlugins()[0]);

    await expect(runtime.health('agent.claude-code')).resolves.toEqual([{
      pluginId: 'agent.claude-code', status: 'degraded', message: 'claude CLI not found on the local host PATH',
    }]);
    await expect(runtime.health('agent.claude-code')).resolves.toEqual([{
      pluginId: 'agent.claude-code', status: 'unhealthy', message: 'claude version check failed on the local host',
    }]);
  });
});
