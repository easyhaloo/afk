import type { WorkItem, WorkState } from './model';

export interface BacklogWorkItemInput {
  id: string;
  title: string;
  state: 'ready' | 'rework' | 'in_progress' | 'verification' | 'merge_ready' | 'done' | 'blocked';
  executionMode: 'afk' | 'hitl';
  parentId?: string;
  baseBacklogId?: string;
  dependsOn: readonly string[];
}

const workStateByBacklogState = {
  ready: 'ready',
  rework: 'rework',
  in_progress: 'implementing',
  verification: 'verifying',
  merge_ready: 'merge_ready',
  done: 'done',
  blocked: 'blocked',
} satisfies Record<BacklogWorkItemInput['state'], WorkState>;

const workModeByExecutionMode = {
  afk: 'autonomous',
  hitl: 'human',
} satisfies Record<BacklogWorkItemInput['executionMode'], WorkItem['mode']>;

export function toCoreWorkItem(item: BacklogWorkItemInput): WorkItem {
  return {
    id: item.id,
    title: item.title,
    state: workStateByBacklogState[item.state],
    mode: workModeByExecutionMode[item.executionMode],
    lineage: {
      parentId: item.parentId,
      dependsOn: [...item.dependsOn],
      baseWorkItemId: item.baseBacklogId,
    },
    revision: 0,
  };
}
