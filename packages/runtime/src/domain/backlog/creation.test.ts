import { describe, expect, it, vi } from 'vitest';
import { TrackerBacklogProvider } from './tracker-provider.js';
import { planBacklogCreate, renderBacklogDescription, resolveBacklogExecutionBase } from './creation.js';
import type { BacklogItem, BacklogProvider } from './index.js';
import type { TrackerProvider, TrackedIssue } from '../tracker/types.js';

const scope = { platform: 'github' as const, projectKey: 'org/repo' };

const item: BacklogItem = { id: 'github:org/repo#42', issueNumber: 42, title: 'Child', state: 'ready', executionMode: 'afk', tags: [], dependsOn: [],
  branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42' };

function trackerOf(issue: TrackedIssue): TrackerProvider {
  return {
    platform: 'github', projectId: 'org/repo',
    getIssue: vi.fn(async () => issue),
    listIssues: vi.fn(async () => [issue]),
    listMRs: vi.fn(async () => []),
    getMR: vi.fn(),
  } as unknown as TrackerProvider;
}

describe('backlog creation and execution base', () => {
  it('plans canonical labels and verifies relationships without writing', async () => {
    const get = vi.fn(async (_id: string) => item);
    const plan = await planBacklogCreate({ get }, { title: ' PRD ', description: 'Body', kind: 'prd',
      parentId: '007', baseBacklogId: '6', dependsOn: ['5', '05', 'github:org/other#5'], idempotencyKey: 'anchor' }, scope);
    expect(plan).toMatchObject({
      title: 'PRD', kind: 'prd',
      parentId: 'github:org/repo#7', baseBacklogId: 'github:org/repo#6',
      dependsOn: ['github:org/repo#5', 'github:org/other#5'],
    });
    // A PRD anchor is a container: it has no lifecycle position, so it gets
    // no stage label, and it defaults to the human-in-the-loop mode.
    expect(plan.state).toBeUndefined();
    expect(plan.labels).toEqual([
      'kind::prd', 'mode::hitl',
      'parent::github:org/repo#7', 'base::github:org/repo#6',
      'depends-on::github:org/repo#5', 'depends-on::github:org/other#5',
      expect.stringMatching(/^idempotency::[a-f0-9]{64}$/),
    ]);
    expect(get.mock.calls.map(call => call[0])).toEqual([
      'github:org/repo#7', 'github:org/repo#6', 'github:org/repo#5', 'github:org/other#5',
    ]);
  });

  it('refuses to create an autonomous PRD anchor', async () => {
    const get = vi.fn(async (_id: string) => item);
    // An anchor groups children and is never executed on its own, so asking
    // for an autonomous one is a contradiction rather than a default.
    await expect(planBacklogCreate({ get }, { title: 'PRD', description: 'Body', kind: 'prd', executionMode: 'afk' }, scope))
      .rejects.toThrow('cannot be autonomous');
    expect(get).not.toHaveBeenCalled();
  });

  it('plans an executable item with a lifecycle stage', async () => {
    const get = vi.fn(async (_id: string) => item);
    const plan = await planBacklogCreate({ get }, { title: 'Child', description: 'Body' }, scope);
    expect(plan).toMatchObject({ state: 'ready', kind: undefined, executionMode: 'afk' });
    expect(plan.labels).toEqual(['stage::ready-for-issues', 'mode::afk']);
  });

  it('resolves a relationship reference against the project the provider owns', async () => {
    // The provider knows its own project, so a bare reference resolves
    // without asking any wrapper for extra state.
    const provider = new TrackerBacklogProvider(trackerOf({
      id: 7, platform: 'github', projectId: 'org/repo', title: 'Parent', description: '', labels: [], state: 'opened', url: '',
    }));
    const plan = await provider.planCreate({ title: 'Child', description: 'Body', parentId: '7' });

    expect(plan.parentId).toBe('github:org/repo#7');
    expect(plan.labels).toContain('parent::github:org/repo#7');
  });

  it('rejects reserved relation tags before reading providers', async () => {
    const get = vi.fn();
    await expect(planBacklogCreate({ get }, { title: 'Child', description: 'Body', baseBacklogId: '1', tags: ['base::2'] }, scope)).rejects.toThrow('reserved');
    expect(get).not.toHaveBeenCalled();
  });

  it('renders the preview and creation description with provider URLs', async () => {
    const parent = { ...item, id: 'github:org/repo#7', issueNumber: 7, webUrl: 'https://example/7' };
    const plan = await planBacklogCreate({ get: async () => parent }, { title: 'Child', description: 'Body', parentId: '7' }, scope);
    expect(plan.description).toBe('Body\n\n## Backlog Links\n\n- Parent backlog: [#7](https://example/7)\n');
    expect(renderBacklogDescription('Body', { ...plan.links, self: { ...item, issueNumber: 42, webUrl: 'https://example/42' } }))
      .toContain('- This backlog: [#42](https://example/42)');
  });

  it.each(['ready', 'verification', 'merge_ready', 'done'] as const)('uses an unmerged base branch until its backlog is done: %s', async state => {
    const get = vi.fn(async () => ({ ...item, id: 'github:org/repo#1', issueNumber: 1, state, branchName: 'afk/backlog-1', providerRef: 'github:org/repo#1' }));
    await expect(resolveBacklogExecutionBase({ get }, { ...item, baseBacklogId: 'github:org/repo#1' }, 'master'))
      .resolves.toBe(state === 'done' ? 'master' : 'afk/backlog-1');
  });

  it('preserves legacy PRD bases without interpreting parent or dependency edges as bases', async () => {
    const get = vi.fn();
    await expect(resolveBacklogExecutionBase({ get }, { ...item, baseBacklogId: 'prd-10' }, 'main')).resolves.toBe('prd/10');
    await expect(resolveBacklogExecutionBase({ get }, { ...item, parentId: 'github:org/repo#1', dependsOn: ['github:org/repo#2'] }, 'main')).resolves.toBe('main');
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects a base branch from another repository', async () => {
    const get = vi.fn(async () => ({ ...item, providerRef: 'github:org/other#1' }));
    await expect(resolveBacklogExecutionBase({ get }, { ...item, baseBacklogId: 'github:org/other#1' }, 'main')).rejects.toThrow('same repository');
  });
});
