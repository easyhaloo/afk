import { describe, expect, it } from 'vitest';
import { explainRunnabilityInInventory } from './runnability.js';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';

function item(overrides: Partial<GlobalWorkItem> & { id: string }): GlobalWorkItem {
  return {
    issueNumber: Number(overrides.id.split('#')[1] ?? 1),
    project: { platform: 'gitlab', projectKey: 'host/group/repo', name: 'repo' },
    title: overrides.id,
    managed: true,
    executionEligible: true,
    executionMode: 'afk',
    dependsOn: [],
    tags: [],
    branchName: 'afk/backlog',
    providerRef: overrides.id,
    ...overrides,
  };
}

describe('explainRunnabilityInInventory', () => {
  it('judges every item against the same snapshot', () => {
    const items = [
      item({ id: 'gitlab:host/group/repo#1', state: 'ready' }),
      item({ id: 'gitlab:host/group/repo#2', state: 'ready', dependsOn: ['gitlab:host/group/repo#1'] }),
    ];
    const result = explainRunnabilityInInventory(items);

    expect(result.get('gitlab:host/group/repo#1')?.runnable).toBe(true);
    expect(result.get('gitlab:host/group/repo#2')).toEqual({
      runnable: false,
      reason: 'dependency_not_done',
      blockedBy: ['gitlab:host/group/repo#1'],
    });
  });

  it('treats a dependency that is missing from the inventory as unfinished', () => {
    // An item whose dependency is not in view waits rather than runs: that is
    // the safe direction for a snapshot that may be incomplete.
    const items = [item({ id: 'gitlab:host/group/repo#2', state: 'ready', dependsOn: ['gitlab:host/group/other#9'] })];
    const result = explainRunnabilityInInventory(items);

    expect(result.get('gitlab:host/group/repo#2')?.reason).toBe('dependency_not_done');
    expect(result.get('gitlab:host/group/repo#2')?.blockedBy).toEqual(['gitlab:host/group/other#9']);
  });

  it('reports an item that owns children as not runnable', () => {
    const items = [
      item({ id: 'gitlab:host/group/repo#1', state: 'ready', parentId: 'gitlab:host/group/repo#10' }),
      item({ id: 'gitlab:host/group/repo#10', state: 'ready' }),
    ];
    const result = explainRunnabilityInInventory(items);

    expect(result.get('gitlab:host/group/repo#10')?.reason).toBe('has_children');
  });

  it('reports an item AFK is working on as such', () => {
    const items = [item({ id: 'gitlab:host/group/repo#1', state: 'in_progress', executionEligible: false })];
    const result = explainRunnabilityInInventory(items);

    expect(result.get('gitlab:host/group/repo#1')?.reason).toBe('execution_in_progress');
  });

  it('reports a PRD anchor as a container', () => {
    const items = [item({ id: 'gitlab:host/group/repo#27', kind: 'prd', executionEligible: false })];
    const result = explainRunnabilityInInventory(items);

    expect(result.get('gitlab:host/group/repo#27')?.reason).toBe('not_execution_eligible');
  });
});
