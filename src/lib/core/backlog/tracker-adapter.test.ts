import { describe, expect, it, vi } from 'vitest';
import { TrackerBacklogProvider } from './tracker-adapter';
import type { ClaimLease } from './claim';
import type { TrackerProvider } from '../tracker/types';

function tracker(issue: any): TrackerProvider {
  return {
    platform: 'github', projectId: 'org/repo',
    getIssue: vi.fn(async () => ({ ...issue })),
    listIssues: vi.fn(async () => [{ ...issue }]),
    updateIssue: vi.fn(async (_id, updates) => { issue.labels = updates.labels ?? issue.labels; }),
  } as unknown as TrackerProvider;
}

describe('TrackerBacklogProvider', () => {
  it('maps labels and relationship metadata to canonical backlog fields', async () => {
    const issue = {
      id: 42, title: 'Child', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'parent::10', 'depends-on::9'],
      state: 'opened', url: 'https://example/42', projectId: 'org/repo',
    };
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim: vi.fn() });
    await expect(provider.get('42')).resolves.toMatchObject({
      id: '42', parentId: '10', dependsOn: ['9'], state: 'ready', executionMode: 'afk', branchName: 'afk/backlog-42',
      webUrl: 'https://example/42',
    });
  });

  it('transitions canonical state by replacing only workflow labels', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'team::api'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });
    await provider.transition('42', 'blocked', { reason: 'timeout' });
    expect(t.updateIssue).toHaveBeenCalledWith(42, { labels: ['team::api', 'stage::blocked', 'mode::hitl'] });
  });

  it('returns null when a second claim observes in-progress state', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const atomicClaim = vi.fn(async () => {
      if (!issue.labels.includes('stage::ready-for-issues')) return false;
      issue.labels = ['stage::afk-in-progress', 'mode::afk'];
      return true;
    });
    const provider = new TrackerBacklogProvider(t, { atomicClaim });
    const first = await provider.claim('42', 'one');
    const second = await provider.claim('42', 'two');
    expect(first?.item.state).toBe('in_progress');
    expect(second).toBeNull();
  });

  it('passes the complete canonical predicate to the atomic claim capability', async () => {
    const dependency = { id: 9, title: 'Dependency', description: '', labels: ['stage::done'], state: 'opened', url: '', projectId: '' };
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'depends-on::9'], state: 'opened', url: '', projectId: '' };
    const atomicClaim = vi.fn(async () => { issue.labels = ['stage::afk-in-progress', 'mode::afk', 'depends-on::9']; return true; });
    const t = tracker(issue);
    t.listIssues = vi.fn(async () => [{ ...issue }, dependency]);
    t.getIssue = vi.fn(async id => id === 9 ? { ...dependency } : { ...issue });
    const provider = new TrackerBacklogProvider(t, { atomicClaim });
    await provider.claim('42', 'worker');
    expect(atomicClaim).toHaveBeenCalledWith('42', 'worker', 'ready', {
      state: 'ready', executionMode: 'afk', parentId: undefined, dependencies: ['9'],
    });
  });

  it('allows a child backlog to claim natively and includes its parent in the predicate', async () => {
    const issue = { id: 42, title: 'Child', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'parent::10'], state: 'opened', url: '', projectId: '' };
    const atomicClaim = vi.fn(async () => { issue.labels = ['stage::afk-in-progress', 'mode::afk', 'parent::10']; return true; });
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim });

    await expect(provider.claim('42', 'worker')).resolves.toMatchObject({ item: { id: '42', parentId: '10', state: 'in_progress' } });

    expect(atomicClaim).toHaveBeenCalledWith('42', 'worker', 'ready', expect.objectContaining({ parentId: '10' }));
  });

  it('maps a closed issue without workflow labels to done for dependency checks', async () => {
    const issue = { id: 9, title: 'Dependency', description: '', labels: [], state: 'closed', url: '', projectId: '' };
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim: vi.fn() });
    await expect(provider.get('9')).resolves.toMatchObject({ state: 'done' });
  });

  it('exposes business tags while hiding provider workflow metadata', async () => {
    const issue = { id: 7, title: 'Tagged', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'team::api'], state: 'opened', url: '', projectId: '' };
    const t = tracker(issue);
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn() });
    await expect(provider.get('7')).resolves.toMatchObject({ tags: ['team::api'] });
    await provider.addTag('7', 'urgent');
    await provider.removeTag('7', 'team::api');
    expect(issue.labels).toEqual(['stage::ready-for-issues', 'mode::afk', 'urgent']);
    await expect(provider.list({ tag: 'urgent' })).resolves.toHaveLength(1);
  });

  it('initializes provider metadata idempotently and reports capabilities', async () => {
    const ensureMetadata = vi.fn(async () => {});
    const t = tracker({ id: 1, title: 'Item', description: '', labels: [], state: 'opened', url: '', projectId: '' });
    const provider = new TrackerBacklogProvider(t, { atomicClaim: vi.fn(), ensureMetadata });
    await provider.initialize();
    await provider.initialize();
    expect(ensureMetadata).toHaveBeenCalledTimes(2);
    expect(provider.capabilities).toEqual({ atomicClaim: true, tags: true, initialization: true });
  });

  it('uses a filesystem lease to serialize tracker claims without native CAS', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    let held = false;
    const claimLock = {
      acquire: vi.fn(async (): Promise<ClaimLease | null> => {
        if (held) return null;
        held = true;
        return lease('fallback-claim', () => { held = false; });
      }),
    };
    const provider = new TrackerBacklogProvider(tracker(issue), { claimLock });

    const [first, second] = await Promise.all([provider.claim('42', 'worker-a'), provider.claim('42', 'worker-b')]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(claimLock.acquire).toHaveBeenCalledWith(expect.objectContaining({
      key: 'github/org/repo/42', owner: expect.any(String),
    }));
    await first?.release();
    await second?.release();
  });

  it('allows a child backlog to claim through the filesystem fallback', async () => {
    const issue = { id: 42, title: 'Child', description: '', labels: ['stage::ready-for-issues', 'mode::afk', 'parent::10'], state: 'opened', url: '', projectId: 'org/repo' };
    const provider = new TrackerBacklogProvider(tracker(issue), { claimLock: { acquire: vi.fn(async () => lease('fallback-child')) } });

    await expect(provider.claim('42', 'worker')).resolves.toMatchObject({ item: { id: '42', parentId: '10', state: 'in_progress' } });
  });

  it('uses native CAS without acquiring a fallback lease', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const claimLock = { acquire: vi.fn(async (): Promise<ClaimLease | null> => lease('unexpected-lock')) };
    const atomicClaim = vi.fn(async () => {
      issue.labels = ['stage::afk-in-progress', 'mode::afk'];
      return true;
    });
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim, claimLock });

    await provider.claim('42', 'worker-a');

    expect(claimLock.acquire).not.toHaveBeenCalled();
  });

  it('releases a fallback lease when the item cannot be claimed', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::hitl'], state: 'opened', url: '', projectId: 'org/repo' };
    const release = vi.fn(async () => {});
    const claimLock = { acquire: vi.fn(async (): Promise<ClaimLease | null> => ({ ...lease('fallback-claim'), release })) };
    const provider = new TrackerBacklogProvider(tracker(issue), { claimLock });

    await expect(provider.claim('42', 'worker-a')).resolves.toBeNull();

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('blocks and routes a native claim when post-CAS confirmation fails', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim: vi.fn(async () => true) });

    await expect(provider.claim('42', 'worker-a')).resolves.toBeNull();

    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
  });

  it('blocks a native claim when CAS rejects after an unknown provider-side commit', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const atomicClaim = vi.fn(async () => {
      issue.labels = ['stage::afk-in-progress', 'mode::afk'];
      throw new Error('CAS response lost');
    });
    const provider = new TrackerBacklogProvider(tracker(issue), { atomicClaim });

    await expect(provider.claim('42', 'worker-a')).rejects.toThrow('CAS response lost');

    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
  });

  it('blocks and releases a fallback lease when post-transition confirmation fails', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(issue);
    t.updateIssue = vi.fn(async (_id, updates) => {
      if (updates.labels?.includes('stage::blocked')) issue.labels = updates.labels;
    });
    const release = vi.fn(async () => {});
    const provider = new TrackerBacklogProvider(t, { claimLock: { acquire: vi.fn(async () => ({ ...lease('fallback-claim'), release })) } });

    await expect(provider.claim('42', 'worker-a')).resolves.toBeNull();

    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('blocks and releases a fallback lease when post-transition re-read throws', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    const t = tracker(issue);
    let reads = 0;
    t.getIssue = vi.fn(async () => {
      reads += 1;
      if (reads === 3) throw new Error('post-transition read failed');
      return { ...issue };
    });
    const release = vi.fn(async () => {});
    const provider = new TrackerBacklogProvider(t, { claimLock: { acquire: vi.fn(async () => ({ ...lease('fallback-claim'), release })) } });

    await expect(provider.claim('42', 'worker-a')).rejects.toThrow('post-transition read failed');

    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('blocks and routes an expired fallback lease to the exact provider-qualified backlog', async () => {
    const issue = { id: 42, title: 'Item', description: '', labels: ['stage::ready-for-issues', 'mode::afk'], state: 'opened', url: '', projectId: 'org/repo' };
    let recoveryKey: string | undefined;
    const claimLockFactory = vi.fn((onExpiredClaim: (key: string) => Promise<boolean>) => ({
      acquire: vi.fn(async ({ key }: { key: string }): Promise<ClaimLease | null> => {
        recoveryKey = key;
        await onExpiredClaim(key);
        return null;
      }),
    }));
    const provider = new TrackerBacklogProvider(tracker(issue), { claimLockFactory });

    await expect(provider.claim('42', 'worker-a')).resolves.toBeNull();

    expect(recoveryKey).toBe('github/org/repo/42');
    expect(issue.labels).toEqual(['stage::blocked', 'mode::hitl']);
  });
});

function lease(claimId: string, onRelease: () => void = () => {}): ClaimLease {
  return { claimId, heartbeat: async () => {}, release: async () => { onRelease(); } };
}
