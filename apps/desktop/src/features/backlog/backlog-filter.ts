import type { BacklogItem, BacklogKind, BacklogState } from "../../../shared/backlog-contract.js";

export type SourceFilter = "all" | BacklogState;

export const BACKLOG_STATE_LABELS: Record<BacklogState, string> = {
  ready: "待处理",
  rework: "返工中",
  in_progress: "进行中",
  verification: "验证中",
  merge_ready: "待合并",
  done: "已完成",
  blocked: "阻塞",
};

/**
 * The label of a role.
 *
 * A PRD anchor is a container: it has no lifecycle position, so the role is
 * what the reader sees.
 */
export const BACKLOG_KIND_LABELS: Record<BacklogKind, string> = {
  prd: "PRD 锚点",
};

export function backlogStateLabel(state: BacklogState): string {
  return BACKLOG_STATE_LABELS[state];
}

/**
 * The label a reader sees for an item's lifecycle position.
 *
 * A PRD anchor is a container: it has no lifecycle position, so the role is
 * what the reader sees instead.
 */
export function backlogLifecycleLabel(item: { state?: BacklogState; kind?: BacklogKind }): string {
  if (item.kind === "prd") return BACKLOG_KIND_LABELS.prd;
  return item.state === undefined ? "—" : BACKLOG_STATE_LABELS[item.state];
}

/** The CSS modifier that goes with the lifecycle label. */
export function backlogLifecycleClass(item: { state?: BacklogState; kind?: BacklogKind }): string {
  if (item.kind === "prd") return "prd";
  return item.state ?? "none";
}

export function filterBacklogItems(items: BacklogItem[], query: string, state: SourceFilter): BacklogItem[] {
  const normalized = query.trim().toLowerCase();
  return items.filter((item) => {
    const matchesQuery = !normalized
      || [item.id, item.title, ...(item.tags ?? [])].some((value) => value.toLowerCase().includes(normalized));
    const matchesState = state === "all" || item.state === state;
    return matchesQuery && matchesState;
  });
}
