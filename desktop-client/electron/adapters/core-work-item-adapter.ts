/**
 * Adapter boundary between the Desktop IPC backlog contract and @afk/core.
 *
 * Desktop must not re-implement core state semantics: the backlog -> core
 * mapping is owned by `@afk/application` (see
 * docs/architecture/blueprints/core-layer-architecture_zh.md), which the
 * Electron main process imports directly now that both are ESM. This file
 * only adapts the Desktop wire types onto that shared projection, so the same
 * backlog item yields the same `WorkItem` here as it does in the CLI.
 */

import { toCoreWorkMode, toCoreWorkState } from "@afk/application";
import type { WorkItem, WorkState } from "@afk/core";
import type { BacklogExecutionMode, BacklogState } from "../../shared/backlog-contract.js";

export function toCoreWorkStateFromBacklog(state: BacklogState): WorkState {
  return toCoreWorkState(state);
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
