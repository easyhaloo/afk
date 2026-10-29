import type { BacklogKind, BacklogState } from "../../../shared/backlog-contract.js";

export type SortableBacklogRow = {
  id: string;
  title: string;
  /** The lifecycle position. A PRD anchor is a container and has none. */
  state?: BacklogState;
  /** The role of the item; `prd` marks an organizational parent. */
  kind?: BacklogKind;
  updatedAt?: string;
};

export type BacklogSortOption = "id" | "title" | "state" | "updatedAt";
export type SortDirection = "asc" | "desc";

export type BacklogSortSelection = {
  field: BacklogSortOption;
  direction: SortDirection;
};

export const BACKLOG_SORT_OPTIONS: Array<{ value: string; label: string; field: BacklogSortOption; direction: SortDirection }> = [
  { value: "id:asc", label: "ID 升序", field: "id", direction: "asc" },
  { value: "id:desc", label: "ID 降序", field: "id", direction: "desc" },
  { value: "title:asc", label: "标题 A→Z", field: "title", direction: "asc" },
  { value: "title:desc", label: "标题 Z→A", field: "title", direction: "desc" },
  { value: "state:asc", label: "状态（待处理优先）", field: "state", direction: "asc" },
  { value: "state:desc", label: "状态（已完成优先）", field: "state", direction: "desc" },
];

export const WORK_ITEM_SORT_OPTIONS: typeof BACKLOG_SORT_OPTIONS = [
  ...BACKLOG_SORT_OPTIONS,
  { value: "updatedAt:desc", label: "最近更新优先", field: "updatedAt", direction: "desc" },
  { value: "updatedAt:asc", label: "最早更新优先", field: "updatedAt", direction: "asc" },
];

const DEFAULT_SORT: BacklogSortSelection = { field: "id", direction: "asc" };

const STATE_ORDER: Record<BacklogState, number> = {
  ready: 0,
  rework: 1,
  in_progress: 2,
  verification: 3,
  merge_ready: 4,
  blocked: 5,
  done: 6,
};

/**
 * Where a row sits in the lifecycle order.
 *
 * A PRD anchor has no lifecycle position, so it sorts ahead of every state:
 * it is the parent the other items hang from.
 */
function lifecycleOrder(row: SortableBacklogRow): number {
  if (row.kind === "prd") return -1;
  return row.state === undefined ? 99 : (STATE_ORDER[row.state] ?? 99);
}

export function parseBacklogSort(value: string | undefined): BacklogSortSelection {
  if (!value) return DEFAULT_SORT;
  const option = [...WORK_ITEM_SORT_OPTIONS, ...BACKLOG_SORT_OPTIONS].find(candidate => candidate.value === value);
  return option ? { field: option.field, direction: option.direction } : DEFAULT_SORT;
}

export function sortBacklogItems<T extends SortableBacklogRow>(items: T[], selection: BacklogSortSelection): T[] {
  const factor = selection.direction === "desc" ? -1 : 1;
  return [...items].sort((left, right) => {
    if (selection.field === "state") {
      const diff = lifecycleOrder(left) - lifecycleOrder(right);
      if (diff !== 0) return diff * factor;
      return left.id.localeCompare(right.id);
    }
    if (selection.field === "updatedAt") {
      if (left.updatedAt !== undefined && right.updatedAt !== undefined) {
        const diff = left.updatedAt.localeCompare(right.updatedAt);
        return diff !== 0 ? diff * factor : left.id.localeCompare(right.id);
      }
      if (left.updatedAt !== undefined) return -1;
      if (right.updatedAt !== undefined) return 1;
      return left.id.localeCompare(right.id);
    }
    const leftValue = left[selection.field];
    const rightValue = right[selection.field];
    const diff = leftValue.localeCompare(rightValue);
    return diff !== 0 ? diff * factor : left.id.localeCompare(right.id);
  });
}
