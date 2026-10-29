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

import { coreWorkKindByBacklogKind, toCoreWorkMode, toCoreWorkState } from "@afk/application";
import type { WorkItem, WorkState } from "@afk/core";
import type { BacklogExecutionMode, BacklogKind, BacklogState } from "../../shared/backlog-contract.js";

export function toCoreWorkStateFromBacklog(state: BacklogState | undefined): WorkState | undefined {
  return toCoreWorkState(state);
}

export function toCoreWorkItemFromBacklog(input: {
  id: string;
  title: string;
  /** The lifecycle position. A PRD anchor is a container and has none. */
  state?: BacklogState;
  /** The role of the item; `prd` marks an organizational parent. */
  kind?: BacklogKind;
  executionMode: BacklogExecutionMode;
  parentId?: string;
  baseBacklogId?: string;
  dependsOn: readonly string[];
}): WorkItem {
  const state = toCoreWorkState(input.state);
  return {
    id: input.id,
    title: input.title,
    ...(state === undefined ? {} : { state }),
    ...(input.kind === undefined ? {} : { kind: coreWorkKindByBacklogKind[input.kind] }),
    mode: toCoreWorkMode(input.executionMode),
    lineage: {
      parentId: input.parentId,
      dependsOn: [...input.dependsOn],
      baseWorkItemId: input.baseBacklogId,
    },
    revision: 0,
  };
}
