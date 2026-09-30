import type { BacklogState } from "../../../shared/backlog-contract";

export type SortableBacklogRow = {
  id: string;
  title: string;
  state: BacklogState;
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

export function parseBacklogSort(value: string | undefined): BacklogSortSelection {
  if (!value) return DEFAULT_SORT;
  const option = [...WORK_ITEM_SORT_OPTIONS, ...BACKLOG_SORT_OPTIONS].find(candidate => candidate.value === value);
  return option ? { field: option.field, direction: option.direction } : DEFAULT_SORT;
}

export function sortBacklogItems<T extends SortableBacklogRow>(items: T[], selection: BacklogSortSelection): T[] {
  const factor = selection.direction === "desc" ? -1 : 1;
  return [...items].sort((left, right) => {
    if (selection.field === "state") {
      const diff = (STATE_ORDER[left.state] ?? 99) - (STATE_ORDER[right.state] ?? 99);
      if (diff !== 0) return diff * factor;
      return left.id.localeCompare(right.id);
    }
    const leftValue = selection.field === "updatedAt" ? left.updatedAt ?? "" : left[selection.field];
    const rightValue = selection.field === "updatedAt" ? right.updatedAt ?? "" : right[selection.field];
    const diff = leftValue.localeCompare(rightValue);
    return diff !== 0 ? diff * factor : left.id.localeCompare(right.id);
  });
}
