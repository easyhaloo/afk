import { describe, expect, it } from 'vitest';
import { buildBacklogGraph, findDependencyCycle } from './graph.js';
import type { BacklogItem } from './index.js';

function item(id: string, overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id, title: id, state: 'ready', executionMode: 'afk', tags: [], dependsOn: [],
    branchName: 'afk/backlog-1', providerRef: id, ...overrides,
  };
}

describe('backlog graph', () => {
  it('joins a child in another repository to its parent', () => {
    const parent = item('github:org/repo#7');
    const child = item('gitlab:group/other#42', { parentId: 'github:org/repo#7' });
    const graph = buildBacklogGraph([parent, child]);

    expect(graph.childrenOf('github:org/repo#7')).toEqual([child]);
    expect(graph.item('github:org/repo#7')).toBe(parent);
  });

  it('keeps the two repositories of one issue number apart', () => {
    const first = item('github:org/repo#7');
    const second = item('github:org/other#7');
    const graph = buildBacklogGraph([first, second]);

    expect(graph.item('github:org/repo#7')).toBe(first);
    expect(graph.item('github:org/other#7')).toBe(second);
  });

  it('reports the items without a parent as the roots', () => {
    const parent = item('github:org/repo#7');
    const child = item('github:org/repo#8', { parentId: 'github:org/repo#7' });
    const graph = buildBacklogGraph([parent, child]);

    expect(graph.roots()).toEqual([parent]);
    expect(graph.childrenOf('github:org/repo#99')).toEqual([]);
  });
});

describe('backlog dependency cycle', () => {
  it('reports the dependency that already reaches the item', async () => {
    const chain: Record<string, string[]> = {
      'github:org/repo#8': ['github:org/repo#9'],
    };
    const read = async (id: string) => chain[id] ?? [];

    await expect(findDependencyCycle('github:org/repo#9', ['github:org/repo#8'], read))
      .resolves.toBe('github:org/repo#9');
  });

  it('reports no cycle when the dependency chain never comes back', async () => {
    const chain: Record<string, string[]> = {
      'github:org/repo#8': ['github:org/repo#7'],
      'github:org/repo#7': [],
    };
    const read = async (id: string) => chain[id] ?? [];

    await expect(findDependencyCycle('github:org/repo#9', ['github:org/repo#8'], read))
      .resolves.toBeUndefined();
  });

  it('stops at an item it has already walked through', async () => {
    const read = async (id: string) => (id === 'github:org/repo#8' ? ['github:org/repo#8'] : []);

    await expect(findDependencyCycle('github:org/repo#9', ['github:org/repo#8'], read))
      .resolves.toBeUndefined();
  });
});
