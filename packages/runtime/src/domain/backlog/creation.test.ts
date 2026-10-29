import { describe, expect, it, vi } from 'vitest';
import { planBacklogCreate, renderBacklogDescription, resolveBacklogExecutionBase } from './creation.js';
import type { BacklogItem } from './index.js';

const scope = { platform: 'github' as const, projectKey: 'org/repo' };

const item: BacklogItem = { id: 'github:org/repo#42', issueNumber: 42, title: 'Child', state: 'ready', executionMode: 'afk', tags: [], dependsOn: [],
  branchName: 'afk/backlog-42', providerRef: 'github:org/repo#42' };

describe('backlog creation and execution base', () => {
  it('plans canonical labels and verifies relationships without writing', async () => {
    const get = vi.fn(async (_id: string) => item);
    const plan = await planBacklogCreate({ get, scope }, { title: ' PRD ', description: 'Body', stage: 'prd',
      parentId: '007', baseBacklogId: '6', dependsOn: ['5', '05', 'github:org/other#5'], idempotencyKey: 'anchor' });
    expect(plan).toMatchObject({
      title: 'PRD', state: 'prd',
      parentId: 'github:org/repo#7', baseBacklogId: 'github:org/repo#6',
      dependsOn: ['github:org/repo#5', 'github:org/other#5'],
    });
    expect(plan.labels).toEqual([
      'stage::prd', 'mode::afk',
      'parent::github:org/repo#7', 'base::github:org/repo#6',
      'depends-on::github:org/repo#5', 'depends-on::github:org/other#5',
      expect.stringMatching(/^idempotency::[a-f0-9]{64}$/),
    ]);
    expect(get.mock.calls.map(call => call[0])).toEqual([
      'github:org/repo#7', 'github:org/repo#6', 'github:org/repo#5', 'github:org/other#5',
    ]);
  });

  it('refuses a relationship reference the provider cannot scope', async () => {
    const get = vi.fn();
    await expect(planBacklogCreate({ get }, { title: 'Child', description: 'Body', parentId: '7' }))
      .rejects.toThrow('identity scope');
    expect(get).not.toHaveBeenCalled();
  });

  it('rejects reserved relation tags before reading providers', async () => {
    const get = vi.fn();
    await expect(planBacklogCreate({ get, scope }, { title: 'Child', description: 'Body', baseBacklogId: '1', tags: ['base::2'] })).rejects.toThrow('reserved');
    expect(get).not.toHaveBeenCalled();
  });

  it('renders the preview and creation description with provider URLs', async () => {
    const parent = { ...item, id: 'github:org/repo#7', issueNumber: 7, webUrl: 'https://example/7' };
    const plan = await planBacklogCreate({ get: async () => parent, scope }, { title: 'Child', description: 'Body', parentId: '7' });
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
