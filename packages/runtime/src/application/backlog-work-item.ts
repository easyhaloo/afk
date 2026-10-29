import type { WorkItem } from '@afk/core';
import {
  coreWorkKindByBacklogKind,
  toCoreWorkMode,
  toCoreWorkState,
  type BacklogExecutionMode,
  type BacklogKind,
  type BacklogState,
} from '@afk/application';

/**
 * Adapter boundary: maps external backlog models (CLI / GitLab backlog
 * naming) onto pure Core `WorkItem` models. Core itself must not know the
 * `afk` / `hitl` backlog naming — see
 * docs/architecture/blueprints/core-layer-architecture_zh.md.
 *
 * The state/mode vocabulary itself is owned by `@afk/application` so the CLI
 * and the Electron desktop client cannot drift apart.
 */

export interface BacklogWorkItemInput {
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
}

export function toCoreWorkItem(item: BacklogWorkItemInput): WorkItem {
  const state = toCoreWorkState(item.state);
  return {
    id: item.id,
    title: item.title,
    ...(state === undefined ? {} : { state }),
    ...(item.kind === undefined ? {} : { kind: coreWorkKindByBacklogKind[item.kind] }),
    mode: toCoreWorkMode(item.executionMode),
    lineage: {
      parentId: item.parentId,
      dependsOn: [...item.dependsOn],
      baseWorkItemId: item.baseBacklogId,
    },
    revision: 0,
  };
}
