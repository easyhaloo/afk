import { describe, expect, it } from 'vitest';
import {
  toCoreWorkItem,
  type BacklogWorkItemInput,
  type WorkItem,
  type WorkState,
} from './index';

const backlogItem = (overrides: Partial<BacklogWorkItemInput> = {}): BacklogWorkItemInput => ({
  id: 'backlog-42',
  title: 'Link backlog items to core work items',
  parentId: 'epic-7',
  baseBacklogId: 'backlog-41',
  dependsOn: ['backlog-40'],
  state: 'ready',
  executionMode: 'afk',
  ...overrides,
});

describe('toCoreWorkItem', () => {
  it('maps identity and lineage while starting at revision zero', () => {
    const item = backlogItem();

    expect(toCoreWorkItem(item)).toEqual<WorkItem>({
      id: 'backlog-42',
      title: 'Link backlog items to core work items',
      state: 'ready',
      mode: 'autonomous',
      lineage: {
        parentId: 'epic-7',
        dependsOn: ['backlog-40'],
        baseWorkItemId: 'backlog-41',
      },
      revision: 0,
    });
  });

  it('does not share the mutable dependency array with the backlog item', () => {
    const dependsOn = ['backlog-40'];
    const item = backlogItem({ dependsOn });
    const result = toCoreWorkItem(item);

    dependsOn.push('backlog-39');

    expect(result.lineage.dependsOn).toEqual(['backlog-40']);
  });

  it.each([
    ['afk', 'autonomous'],
    ['hitl', 'human'],
  ] as const)('maps %s execution to %s mode', (executionMode, mode) => {
    expect(toCoreWorkItem(backlogItem({ executionMode })).mode).toBe(mode);
  });

  it.each(
    [
      ['ready', 'ready'],
      ['rework', 'rework'],
      ['in_progress', 'implementing'],
      ['verification', 'verifying'],
      ['merge_ready', 'merge_ready'],
      ['done', 'done'],
      ['blocked', 'blocked'],
    ] satisfies ReadonlyArray<readonly [BacklogWorkItemInput['state'], WorkState]>,
  )('maps %s state to %s', (state, expected) => {
    expect(toCoreWorkItem(backlogItem({ state })).state).toBe(expected);
  });
});
