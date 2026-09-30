import { describe, expect, it } from 'vitest';
import { decide, initialRunAggregate } from '@afk/core';
import {
  toCoreWorkItemFromBacklog,
  toCoreWorkStateFromBacklog,
} from '../../electron/adapters/core-work-item-adapter';
import type { WorkItem, WorkState } from '@afk/core';

describe('backlog -> core adapter', () => {
  it('reuses @afk/core policy for an empty aggregate (workspace link is live)', () => {
    const decision = decide(initialRunAggregate(), { type: 'start', runId: 'run-1' });
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBe('run_not_found');
  });


  it('maps backlog states onto core WorkState vocabulary', () => {
    expect(toCoreWorkStateFromBacklog('in_progress')).toBe('implementing');
    expect(toCoreWorkStateFromBacklog('verification')).toBe('verifying');
    expect(toCoreWorkStateFromBacklog('merge_ready')).toBe('merge_ready');
  });

  it('maps backlog items to core WorkItem models with isolated lineage', () => {
    const dependsOn = ['backlog-40'];
    const item = toCoreWorkItemFromBacklog({
      id: 'backlog-42',
      title: 'Reuse core in desktop',
      state: 'ready',
      executionMode: 'afk',
      parentId: 'epic-7',
      baseBacklogId: 'backlog-41',
      dependsOn,
    });
    dependsOn.push('backlog-39');

    expect(item).toEqual<WorkItem>({
      id: 'backlog-42',
      title: 'Reuse core in desktop',
      state: 'ready',
      mode: 'autonomous',
      lineage: {
        parentId: 'epic-7',
        dependsOn: ['backlog-40'],
        baseWorkItemId: 'backlog-41',
      },
      revision: 0,
    });
    expect<WorkState>(item.state).toBe('ready');
  });

  it('maps hitl execution to the human mode', () => {
    const item = toCoreWorkItemFromBacklog({
      id: 'backlog-1',
      title: 'Human in the loop item',
      state: 'blocked',
      executionMode: 'hitl',
      dependsOn: [],
    });
    expect(item.mode).toBe('human');
    expect(item.state).toBe('blocked');
  });
});
