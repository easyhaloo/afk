import { describe, expect, it } from 'vitest';
import { inspectConfiguredPlugins } from './configured.js';
import type { PluginConfigValue } from '../../plugin-sdk/profile.js';

describe('operation credential metadata after static discovery integration', () => {
  it.each([
    ['artifact.report-platform', 'artifact.provider'],
    ['notification.feishu', 'notification.provider'],
    ['notification.slack', 'notification.provider'],
  ] as const)('%s inspects expiring named references without resolving them', (id, capability) => {
    const reference = { provider: 'credential.fixture', name: 'operation-token', scope: 'operation:write', expiresAt: '2000-01-01T00:00:00+00:00' };
    const config: PluginConfigValue = id === 'artifact.report-platform'
      ? { endpoint: 'https://reports.example.test', token: reference }
      : { webhook: reference };
    const [metadata] = inspectConfiguredPlugins({ configurations: [{ id, config }], environment: {} });
    expect(metadata.manifest.provides).toContain(capability);
    expect(metadata.credentialDependencies).toEqual(['credential.fixture']);
  });
});
