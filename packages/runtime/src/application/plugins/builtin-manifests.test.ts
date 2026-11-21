import { describe, expect, it, vi } from 'vitest';
import { builtinPluginManifests, builtinExternalTools, configuredExternalTools } from './builtin-manifests.js';
import { validateManifest } from '../../plugin-sdk/profile.js';
import { AgentProviderRegistry, ensureBuiltinAgentProviders, ProcessAgentProvider } from '../../domain/agents/index.js';
import { desktopNotificationCommand } from '../../infrastructure/providers/notifications.js';

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw new Error('static inventory must not execute'); }),
  execFile: vi.fn(() => { throw new Error('static inventory must not execute'); }),
}));

describe('builtin external tool inventory', () => {
  it('publishes six backend agent commands matching actual command construction', () => {
    const registry = new AgentProviderRegistry();
    ensureBuiltinAgentProviders(registry);
    const manifests = builtinPluginManifests('/unused');
    expect(registry.list()).toHaveLength(6);
    for (const provider of registry.list()) {
      if (!(provider instanceof ProcessAgentProvider)) throw new Error('Expected a process agent');
      const command = provider.buildCommand({ worktreePath: '/unused', sessionId: 'static' }).argv[0];
      const manifest = manifests.find(candidate => candidate.id === `agent.${provider.name}`)!;
      expect(manifest.externalTools).toEqual([expect.objectContaining({ command, location: 'backend', version: { args: ['--version'] } })]);
      expect(() => validateManifest(manifest)).not.toThrow();
    }
  });

  it.each([
    ['host.ssh', 'ssh', ['-V']],
    ['host.aws-ssm', 'aws', ['--version']],
    ['host.kubernetes-exec', 'kubectl', ['version', '--client', '--output=json']],
    ['sandbox.docker', 'docker', ['--version']],
    ['sandbox.podman', 'podman', ['--version']],
  ])('declares %s on the host without contacting a target or daemon', (id, command, args) => {
    expect(builtinPluginManifests('/unused').find(manifest => manifest.id === id)?.externalTools)
      .toContainEqual(expect.objectContaining({ command, location: 'host', version: { args } }));
  });

  it('declares jms conservatively and the optional browser CLI at its execution location', () => {
    expect(builtinExternalTools('host.jumpserver')).toEqual([expect.objectContaining({ command: 'jms', location: 'host' })]);
    expect(builtinExternalTools('host.jumpserver')[0].version).toBeUndefined();
    expect(builtinExternalTools('verification.browser-check')).toEqual([expect.objectContaining({ command: 'playwright', location: 'backend', optional: true })]);
    expect(builtinExternalTools('host.ssh').map(tool => tool.command)).toEqual(['ssh', 'scp']);
    expect(builtinExternalTools('context.experience')).toEqual([]);
    for (const manifest of builtinPluginManifests('/unused')) expect(() => validateManifest(manifest)).not.toThrow();
  });

  it.each(['darwin', 'linux', 'win32'] as const)('declares the actual %s desktop command without a notification or version probe', platform => {
    const command = desktopNotificationCommand(platform, { title: 'inventory', body: 'passive' }).command;
    const projection = configuredExternalTools('notification.desktop', { platform });
    expect(projection.unsupported).toEqual([]);
    expect(projection.declarations).toEqual([expect.objectContaining({ command, location: 'host', platforms: [platform] })]);
    expect(projection.declarations[0].version).toBeUndefined();
    expect(() => validateManifest({ id: 'notification.desktop', version: '1.0.0', apiVersion: 1, trusted: true,
      provides: ['notification.provider'], externalTools: projection.declarations })).not.toThrow();
  });

  it('includes the current desktop executable in default metadata', () => {
    const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
    expect(builtinPluginManifests('/unused').find(manifest => manifest.id === 'notification.desktop')?.externalTools)
      .toEqual(configuredExternalTools('notification.desktop', { platform }).declarations);
    expect(builtinExternalTools('notification.desktop')).toHaveLength(1);
  });

  it('declares bare sendmail without probing delivery and preserves exact path binding safety', () => {
    const declarations = builtinExternalTools('notification.email');
    expect(declarations).toEqual([expect.objectContaining({ id: 'sendmail', command: 'sendmail', location: 'host' })]);
    expect(declarations[0].version).toBeUndefined();
    expect(configuredExternalTools('notification.email', { sendmailPath: 'sendmail' }))
      .toEqual({ declarations, unsupported: [] });
    const configurations: Record<string, string>[] = [{}, { sendmailPath: '/usr/sbin/sendmail' }, { sendmailPath: '/opt/custom/sendmail' }];
    for (const config of configurations) {
      expect(configuredExternalTools('notification.email', config)).toEqual({ declarations: [], unsupported: [
        expect.objectContaining({ id: 'sendmail', command: config.sendmailPath ?? '/usr/sbin/sendmail', status: 'unsupported', reason: 'custom-binding' }),
      ] });
    }
  });
});
