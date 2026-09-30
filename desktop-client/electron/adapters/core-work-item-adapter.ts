/**
 * Adapter boundary between the Desktop IPC backlog contract and @afk/core.
 *
 * Desktop must not re-implement core state semantics: the projections here
 * are typed against `@afk/core` models so any divergence in core's
 * `WorkState` vocabulary fails typecheck. Value-level reuse of a shared
 * backlog->core mapping will move to `@afk/application` (phase three of
 * docs/architecture/core-layer-architecture_zh.md); until then this file is
 * the only place in desktop-client that names the mapping.
 *
 * Type-only imports from '@afk/core' keep this module safe for the
 * CommonJS Electron main build (no ESM runtime require).
 */

import type { WorkItem, WorkState } from '@afk/core';
import type { BacklogExecutionMode, BacklogState } from '../../shared/backlog-contract';

const workStateByBacklogState: Record<BacklogState, WorkState> = {
  ready: 'ready',
  rework: 'rework',
  in_progress: 'implementing',
  verification: 'verifying',
  merge_ready: 'merge_ready',
  done: 'done',
  blocked: 'blocked',
};

const workModeByExecutionMode: Record<BacklogExecutionMode, WorkItem['mode']> = {
  afk: 'autonomous',
  hitl: 'human',
};

export function toCoreWorkStateFromBacklog(state: BacklogState): WorkState {
  return workStateByBacklogState[state];
}

export function toCoreWorkItemFromBacklog(input: {
  id: string;
  title: string;
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  parentId?: string;
  baseBacklogId?: string;
  dependsOn: readonly string[];
}): WorkItem {
  return {
    id: input.id,
    title: input.title,
    state: toCoreWorkStateFromBacklog(input.state),
    mode: workModeByExecutionMode[input.executionMode],
    lineage: {
      parentId: input.parentId,
      dependsOn: [...input.dependsOn],
      baseWorkItemId: input.baseBacklogId,
    },
    revision: 0,
  };
}
