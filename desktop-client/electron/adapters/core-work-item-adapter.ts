/**
 * Adapter boundary between the Desktop IPC backlog contract and @afk/core.
 *
 * Desktop must not re-implement core state semantics: the backlog -> core
 * mapping is owned by `@afk/application` (see
 * docs/architecture/blueprints/core-layer-architecture_zh.md) and reaches the
 * CommonJS Electron main process as a value through the pre-bundled
 * `dist-electron/application.cjs` loaded by `./application-module`. This file
 * only adapts the Desktop wire types onto that shared projection, so the same
 * backlog item yields the same `WorkItem` here as it does in the CLI.
 *
 * Type-only imports from '@afk/core' keep this module safe for the
 * CommonJS Electron main build (no ESM runtime require).
 */

import type { WorkItem, WorkState } from '@afk/core';
import type { BacklogExecutionMode, BacklogState } from '../../shared/backlog-contract';
import { loadApplication } from './application-module';

export function toCoreWorkStateFromBacklog(state: BacklogState): WorkState {
  return loadApplication().toCoreWorkState(state);
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
  const { toCoreWorkMode, toCoreWorkState } = loadApplication();
  return {
    id: input.id,
    title: input.title,
    state: toCoreWorkState(input.state),
    mode: toCoreWorkMode(input.executionMode),
    lineage: {
      parentId: input.parentId,
      dependsOn: [...input.dependsOn],
      baseWorkItemId: input.baseBacklogId,
    },
    revision: 0,
  };
}
