import { describe, expect, it, vi } from 'vitest';
import { TrackerBacklogProvider } from '../src/backlog/tracker-adapter.js';
import { InventoryBacklogProvider } from '../src/application/work-items/inventory-backlog-provider.js';
import type { ProviderCatalog, ProviderProjectRef, TrackerIssueOperations, TrackerMergeReader, TrackedIssue } from '@afk/application';

const PROJECT: ProviderProjectRef = {
  platform: 'github',
  projectKey: 'acme/app',
  name: 'app',
  defaultBranch: 'main',
};

interface IssueSeed {
  readonly id: number;
  readonly labels: readonly string[];
  readonly state?: TrackedIssue['state'];
}

function trackerOf(seeds: readonly IssueSeed[]): TrackerIssueOperations & TrackerMergeReader {
  const issues: TrackedIssue[] = seeds.map(seed => ({
    id: seed.id,
    platform: 'github',
    title: `Issue ${seed.id}`,
    description: '',
    labels: [...seed.labels],
    state: seed.state ?? 'opened',
    url: `https://github.com/acme/app/issues/${seed.id}`,
    projectId: 'acme/app',
  }));
  return {
    platform: 'github',
    projectId: 'acme/app',
    getIssue: vi.fn(async (id: number) => {
      const found = issues.find(issue => issue.id === id);
      if (!found) throw new Error(`no issue ${id}`);
      return { ...found };
    }),
    listIssues: vi.fn(async () => issues.map(issue => ({ ...issue }))),
    listMRs: vi.fn(async () => []),
  } as unknown as TrackerIssueOperations & TrackerMergeReader;
}

function catalogOf(seeds: readonly IssueSeed[]): ProviderCatalog {
  return {
    platform: 'github',
    scopeKey: 'github.com',
    async listProjects() { return [PROJECT]; },
    async listIssues() {
      return seeds.map(seed => ({
        issueNumber: seed.id,
        title: `Issue ${seed.id}`,
        labels: [...seed.labels],
        state: seed.state === 'closed' || seed.state === 'merged' ? 'closed' as const : 'opened' as const,
        webUrl: `https://github.com/acme/app/issues/${seed.id}`,
      }));
    },
  };
}

const MANAGED = ['stage::ready-for-issues', 'mode::afk'];

describe('backlog identity across providers', () => {
  it('filters the project tracker with an id read from the global inventory', async () => {
    const tracker = new TrackerBacklogProvider(trackerOf([
      { id: 9, labels: MANAGED },
      { id: 42, labels: [...MANAGED, 'parent::9'] },
    ]));
    const inventory = new InventoryBacklogProvider({
      catalogs: () => [catalogOf([
        { id: 9, labels: MANAGED },
        { id: 42, labels: [...MANAGED, 'parent::9'] },
      ])],
    });

    const items = await inventory.list();
    const child = items.find(item => item.id === 'github:acme/app#42');
    expect(child?.parentId).toBe('github:acme/app#9');

    await expect(tracker.list({ parentId: child?.parentId })).resolves.toMatchObject([{ id: '42', parentId: '9' }]);
  });

  it('rejects a project tracker id loudly in the global inventory', async () => {
    const inventory = new InventoryBacklogProvider({
      catalogs: () => [catalogOf([{ id: 42, labels: [...MANAGED, 'parent::9'] }])],
    });

    await expect(inventory.list({ parentId: '9' })).rejects.toThrow(/ambiguous/);
  });

  it('understands a canonical id of another project and matches nothing', async () => {
    const tracker = new TrackerBacklogProvider(trackerOf([
      { id: 9, labels: MANAGED },
      { id: 42, labels: [...MANAGED, 'parent::9'] },
    ]));

    await expect(tracker.list({ parentId: 'gitlab:host/group/proj#7' })).resolves.toEqual([]);
  });

  it.each(['abc', '', '0', '1.5', 'github:acme/app#007'])(
    'rejects the malformed filter id %j loudly in both providers',
    async parentId => {
      const tracker = new TrackerBacklogProvider(trackerOf([{ id: 42, labels: MANAGED }]));
      const inventory = new InventoryBacklogProvider({ catalogs: () => [catalogOf([{ id: 42, labels: MANAGED }])] });

      await expect(tracker.list({ parentId })).rejects.toThrow(/not a valid identity/);
      await expect(inventory.list({ parentId })).rejects.toThrow(/not a valid identity/);
    },
  );

  it('reads a relation label written in the global grammar as the same relation in both providers', async () => {
    const label = 'parent::github:acme/app#9';
    const tracker = new TrackerBacklogProvider(trackerOf([{ id: 42, labels: [...MANAGED, label] }]));
    const inventory = new InventoryBacklogProvider({
      catalogs: () => [catalogOf([{ id: 42, labels: [...MANAGED, label] }])],
      trackerFor: async () => trackerOf([{ id: 42, labels: [...MANAGED, label] }]),
    });

    await expect(tracker.get('42')).resolves.toMatchObject({ parentId: '9' });
    await expect(inventory.get('github:acme/app#42')).resolves.toMatchObject({ parentId: 'github:acme/app#9' });
    await expect(tracker.list({ parentId: 'github:acme/app#9' })).resolves.toMatchObject([{ id: '42' }]);
  });

  it('does not drop a canonical relation label in the project tracker', async () => {
    const tracker = new TrackerBacklogProvider(trackerOf([
      { id: 42, labels: [...MANAGED, 'parent::gitlab:host/group/proj#7'] },
    ]));

    await expect(tracker.get('42')).resolves.toMatchObject({ parentId: 'gitlab:host/group/proj#7' });
  });

  it('reads an unlabelled issue the same way in both providers', async () => {
    const tracker = new TrackerBacklogProvider(trackerOf([{ id: 42, labels: [] }]));
    const inventory = new InventoryBacklogProvider({
      catalogs: () => [catalogOf([{ id: 42, labels: [] }])],
      trackerFor: async () => trackerOf([{ id: 42, labels: [] }]),
    });

    const tracked = await tracker.get('42');
    const global = await inventory.get('github:acme/app#42');

    expect(tracked).toMatchObject({ state: 'blocked', executionMode: 'hitl' });
    expect(global).toMatchObject({ state: 'blocked', executionMode: 'hitl' });
  });

  it('never runs an unlabelled issue through the project tracker', async () => {
    const tracker = new TrackerBacklogProvider(trackerOf([{ id: 42, labels: [] }]), { atomicClaim: vi.fn() });

    const item = await tracker.get('42');
    await expect(tracker.isRunnable(item)).resolves.toBe(false);
  });

  it('reads a merged issue as done in both providers', async () => {
    const tracker = new TrackerBacklogProvider(trackerOf([{ id: 42, labels: MANAGED, state: 'merged' }]));
    const inventory = new InventoryBacklogProvider({
      catalogs: () => [],
      trackerFor: async () => trackerOf([{ id: 42, labels: MANAGED, state: 'merged' }]),
    });

    await expect(tracker.get('42')).resolves.toMatchObject({ state: 'done' });
    await expect(inventory.get('github:acme/app#42')).resolves.toMatchObject({ state: 'done' });
  });
});
