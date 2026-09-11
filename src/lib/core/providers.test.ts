import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { createManagementProviderBundle, createProviderBundle } from './providers';
import type { TrackerProvider } from './tracker/types';
import type { ClaimLock } from './backlog/claim-strategy';

describe('provider bundle', () => {
  it('selects the GitHub-specific backlog provider', () => {
    const tracker = { platform: 'github', projectId: 'org/repo' } as TrackerProvider;
    const bundle = createProviderBundle(tracker, '/repo', { atomicClaim: vi.fn(async () => true) });
    expect(bundle.backlog.constructor.name).toBe('GitHubBacklogProvider');
    expect(bundle.branches.constructor.name).toBe('GitBranchProvider');
    expect(bundle.changes.constructor.name).toBe('TrackerChangeProvider');
  });

  it('selects the GitLab-specific backlog provider', () => {
    const tracker = { platform: 'gitlab', projectId: 'group/project' } as TrackerProvider;
    const bundle = createProviderBundle(tracker, '/repo', { atomicClaim: vi.fn(async () => true) });

    expect(bundle.backlog.constructor.name).toBe('GitLabBacklogProvider');
  });

  it('exposes a claim-free management backlog surface', () => {
    const tracker = { platform: 'github', projectId: 'org/repo' } as TrackerProvider;
    const bundle = createManagementProviderBundle(tracker, '/repo');

    expect('claim' in bundle.backlog).toBe(false);
    expectTypeOf(bundle.backlog).not.toHaveProperty('claim');
    expectTypeOf(bundle.backlog).toHaveProperty('get');
    expectTypeOf(bundle.backlog).toHaveProperty('transition');
  });

  it('passes atomic claim capability to the backlog adapter', async () => {
    const atomicClaim = vi.fn(async () => true);
    const tracker = { platform: 'github', projectId: 'org/repo' } as TrackerProvider;
    const bundle = createProviderBundle(tracker, '/repo', { atomicClaim });
    expect(bundle.backlog).toBeDefined();
    expect(atomicClaim).not.toHaveBeenCalled();
  });

  it('configures filesystem fallback with a provider-qualified claim key', async () => {
    const acquire = vi.fn(async () => null);
    let expiryRecovery: ((key: string, claim: unknown) => Promise<boolean>) | undefined;
    const claimLockFactory = vi.fn((onExpiredClaim: (key: string, claim: any) => Promise<boolean>): ClaimLock => {
      expiryRecovery = onExpiredClaim;
      return { acquire };
    });
    const tracker = {
      platform: 'github',
      projectId: 'org/repo',
      getIssue: vi.fn(async () => ({
        id: 42, platform: 'github', projectId: 'org/repo', title: 'item', description: '', labels: [],
        state: 'opened', url: '',
      })),
      listIssues: vi.fn(async () => []),
    } as unknown as TrackerProvider;
    const bundle = createProviderBundle(tracker, '/repo', { claimLockFactory });

    await bundle.backlog.claim('42', 'worker');

    expect(claimLockFactory).toHaveBeenCalledWith(expect.any(Function));
    expect(expiryRecovery).toEqual(expect.any(Function));
    expect(acquire).toHaveBeenCalledWith({ key: 'github/org/repo/42', owner: 'worker', ttlMs: expect.any(Number) });
  });
});
