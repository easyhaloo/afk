import type { ExecutionRunDetail, ExecutionSummary } from "../../../shared/execution-contract";
import { createQueryCache } from "./execution-query-cache";

/** One page of execution summaries as the main process returns it. */
export type ExecutionPage = { executions: ExecutionSummary[]; nextCursor?: string };

/** How a page merges into the history of a key. */
export type ExecutionMergeMode = "refresh" | "more" | "lookup";

/** The history of one work item — or of every work item — as the cache holds it. */
export type ExecutionHistoryState = {
  executions: ExecutionSummary[];
  nextCursor?: string;
  paginated: boolean;
};

/**
 * The key of a history query. The work item is part of the key, so the
 * history of one work item and the history of every work item are two
 * entries and never share a cursor, an error or a poll timer.
 */
export function executionHistoryKey(workItemId?: string): string {
  return JSON.stringify(["history", workItemId ?? null]);
}

/** The key of a detail query. A run belongs to exactly one work item. */
export function executionDetailKey(runId: string, workItemId: string): string {
  return JSON.stringify(["detail", runId, workItemId]);
}

/** The shared history cache. Every surface reads the same entries. */
export const executionHistoryCache = createQueryCache<ExecutionHistoryState>(() => ({ executions: [], paginated: false }));

/** The shared detail cache. Every surface reads the same entries. */
export const executionDetailCache = createQueryCache<ExecutionRunDetail | null>(() => null);

/**
 * Merge a page into the history of a key.
 *
 * A refreshed record wins over a stale one by sequence, a refresh keeps the
 * records it already had, a "more" page appends, and the cursor only moves in
 * the modes that may move it.
 */
export function mergeExecutionPage(
  state: ExecutionHistoryState,
  page: ExecutionPage,
  mode: ExecutionMergeMode,
  workItemId?: string,
): ExecutionHistoryState {
  const known = new Map(state.executions.map(execution => [execution.runId, execution]));
  const incoming = new Map<string, ExecutionSummary>();
  for (const execution of page.executions) {
    if (workItemId && execution.workItemId !== workItemId) continue;
    const previous = incoming.get(execution.runId) ?? known.get(execution.runId);
    incoming.set(execution.runId, previous && previous.sequence > execution.sequence ? previous : execution);
  }
  const executions = mode === "refresh"
    ? [...incoming.values(), ...state.executions.filter(execution => !incoming.has(execution.runId))]
    : [...state.executions.map(execution => incoming.get(execution.runId) ?? execution), ...[...incoming.values()].filter(execution => !known.has(execution.runId))];
  return {
    executions,
    paginated: state.paginated || mode === "more",
    nextCursor: mode === "more" || (mode === "refresh" && !state.paginated) ? page.nextCursor : state.nextCursor,
  };
}

/** Refetch the history of one work item, or of every work item. */
export function invalidateExecutionHistory(workItemId?: string): void {
  executionHistoryCache.invalidate(executionHistoryKey(workItemId));
}

/** Refetch every history, so a run started in one surface reaches the others. */
export function invalidateExecutionHistories(): void {
  executionHistoryCache.invalidateAll();
}

