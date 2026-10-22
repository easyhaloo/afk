import type { WorkItem } from '@afk/core';
import {
  toCoreWorkMode,
  toCoreWorkState,
  type BacklogExecutionMode,
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
  state: BacklogState;
  executionMode: BacklogExecutionMode;
  parentId?: string;
  baseBacklogId?: string;
  dependsOn: readonly string[];
}

export function toCoreWorkItem(item: BacklogWorkItemInput): WorkItem {
  return {
    id: item.id,
    title: item.title,
    state: toCoreWorkState(item.state),
    mode: toCoreWorkMode(item.executionMode),
    lineage: {
      parentId: item.parentId,
      dependsOn: [...item.dependsOn],
      baseWorkItemId: item.baseBacklogId,
    },
    revision: 0,
  };
}
