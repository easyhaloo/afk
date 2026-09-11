import type { BacklogItem, BacklogState } from "../../../shared/backlog-contract";

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

export function backlogStateLabel(state: BacklogState): string {
  return BACKLOG_STATE_LABELS[state];
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
