import { describe, expect, it } from 'vitest';
import { listWorkItemChildren } from './children.js';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';

function item(id: string, overrides: Partial<GlobalWorkItem> = {}): GlobalWorkItem {
  const [identity, issueNumber] = id.split('#');
  const platform = identity?.startsWith('github') ? 'github' : 'gitlab';
  const projectKey = identity?.split(':')[1] ?? 'group/repo';
  return {
    id,
    issueNumber: Number(issueNumber),
    project: { platform, projectKey, name: projectKey.split('/').at(-1) ?? projectKey },
    title: id,
    managed: true,
    executionEligible: true,
    state: 'ready',
    executionMode: 'afk',
    dependsOn: [],
    tags: [],
    branchName: `feature/${issueNumber}`,
    providerRef: id,
    ...overrides,
  };
}

// A PRD anchor is a container: it carries the role and has no state.
const parent = item('gitlab:group/repo#7', { kind: 'prd', state: undefined, executionEligible: false, title: 'the PRD' });
const child = item('gitlab:group/repo#8', { parentId: parent.id, title: 'child' });
const foreign = item('gitlab:group/other#9', { parentId: 'gitlab:group/repo#404', title: 'other parent' });

describe('work item children', () => {
  it('answers the children of one identity from the local inventory', async () => {
    const result = await listWorkItemChildren({
      read: async () => ({ items: [parent, child, foreign], stale: false }),
      refresh: async () => undefined,
    }, { parentId: parent.id });

    expect(result.source).toBe('inventory');
    expect(result.parent.title).toBe('the PRD');
    expect(result.children.map(entry => entry.id)).toEqual([child.id]);
  });

  it('orders the children by project and issue number', async () => {
    const second = item('github:org/api#3', { parentId: parent.id });
    const first = item('gitlab:group/repo#2', { parentId: parent.id });

    const result = await listWorkItemChildren({
      read: async () => ({ items: [parent, second, first], stale: false }),
      refresh: async () => undefined,
    }, { parentId: parent.id });

    expect(result.children.map(entry => entry.id)).toEqual([first.id, second.id]);
  });

  it('refreshes the inventory when the local copy is stale', async () => {
    let refreshed = false;

    const result = await listWorkItemChildren({
      read: async () => ({ items: [], stale: true }),
      refresh: async () => {
        refreshed = true;
        return { items: [parent, child] };
      },
    }, { parentId: parent.id });

    expect(refreshed).toBe(true);
    expect(result.source).toBe('refreshed');
    expect(result.children.map(entry => entry.id)).toEqual([child.id]);
  });

  it('reports an unknown identity instead of an empty list', async () => {
    await expect(listWorkItemChildren({
      read: async () => ({ items: [parent, child], stale: false }),
      refresh: async () => undefined,
    }, { parentId: 'gitlab:group/repo#404' })).rejects.toThrow(/not found/i);
  });
});
