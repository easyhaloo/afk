import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  tracker: vi.fn(async () => ({ platform: 'gitlab' })),
  bundle: vi.fn(() => ({ backlog: {}, branches: {}, changes: {} })),
  graph: vi.fn(() => ({ childrenOf: vi.fn() })),
}));
vi.mock('./tracker-provider-factory.js', () => ({ createTracker: mocks.tracker }));
vi.mock('./providers.js', () => ({ createProviderBundle: mocks.bundle, asManagementProviders: (bundle: unknown) => bundle }));
vi.mock('./backlog-graph.js', () => ({ createCrossProjectBacklogGraphSource: mocks.graph }));
import { assembleProviders } from './assembly.js';
describe('assembleProviders', () => {
  beforeEach(() => vi.clearAllMocks());
  it('routes a canonical self-hosted identity and shares its graph and providers', async () => {
    const result = await assembleProviders({ workItemId: 'gitlab:git.example.com/group/api#42', cwd: '/tmp/api' });
    expect(mocks.tracker).toHaveBeenCalledWith('group/api', '/tmp/api', 'gitlab', 'git.example.com');
    expect(mocks.bundle).toHaveBeenCalledWith(expect.anything(), '/tmp/api', expect.objectContaining({
      projectKey: 'git.example.com/group/api', graph: expect.anything(),
    }));
    expect(result.providers).toBe(result.management);
  });
  it('rejects conflicting scope before creating a tracker', async () => {
    await expect(assembleProviders({ workItemId: 'github:acme/api#1', platform: 'gitlab' })).rejects.toThrow('conflicts');
    await expect(assembleProviders({ workItemId: 'gitlab:git.example.com/group/api#1', providerHost: 'other.example.com' })).rejects.toThrow('conflicts');
    expect(mocks.tracker).not.toHaveBeenCalled();
  });
});
