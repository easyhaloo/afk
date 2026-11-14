import { expect, it, vi } from 'vitest';
import { createConfiguredPlugins } from './configured.js';
import { PluginRuntime } from './runtime.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';

it.each(['artifact.report-platform', 'notification.feishu', 'notification.slack'] as const)('%s rejects a missing exact upstream during passive activation', async id => {
  const runtime = new PluginRuntime();
  const resolve = vi.fn(async () => ({ secret: 'unused' }));
  const fetch = vi.fn(async () => new Response('unused'));
  try {
    await runtime.activate({
      manifest: { id: 'credential.fallback', version: '1.0.0', apiVersion: 1, provides: ['credential.provider'], trusted: true },
      activate(context) {
        context.registerCredentialProvider('fallback', { id: 'fallback', capabilities: { read: true, rotate: false, 'scoped-token': false }, resolve });
      },
    });
    const reference = { provider: 'missing', name: 'operation' };
    const config: PluginConfigValue = id === 'artifact.report-platform'
      ? { endpoint: 'https://reports.example.test', token: reference } : { webhook: reference };
    const [consumer] = await createConfiguredPlugins({ configurations: [{ id, config }], fetch });
    await expect(runtime.activate(consumer)).rejects.toThrow('credential provider is not active');
    expect(runtime.listProvidersForPlugin(id)).toEqual([]);
    expect(resolve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  } finally {
    await runtime.close();
  }
});
