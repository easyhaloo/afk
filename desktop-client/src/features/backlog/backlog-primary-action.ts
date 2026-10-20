import type { BacklogItem, BacklogRuntimeSummary } from "../../../shared/backlog-contract";

/**
 * The action the backlog list offers on an item.
 */
export type BacklogPrimaryAction = "start" | "view-run" | "stop" | "recover" | "retry" | "confirm-merge" | "view-result" | "view";

/**
 * Which action the backlog list offers on an item.
 *
 * The item's state, its mode, whether it is a root item, and what the
 * runtime says about it decide this. The rule used to live in the view, so
 * exercising it meant importing the whole view and a renderer with it; it
 * sits here now, with the rest of the backlog's plain logic.
 */
export function getBacklogPrimaryAction(item: BacklogItem, summary?: BacklogRuntimeSummary): BacklogPrimaryAction {
  if (summary?.runtime?.status === "stale") return "recover";
  const localRunning = summary?.activeRun?.status === "starting" || summary?.activeRun?.status === "running";
  const localAlive = localRunning && summary?.activeRun?.pid !== undefined;
  if ((item.state === "in_progress" || item.state === "verification") && localAlive) return "stop";
  if (localRunning || summary?.runtime?.status === "running") return "view-run";
  if ((item.state === "ready" || item.state === "rework") && item.executionMode === "afk") return "start";
  if (item.state === "blocked" && item.executionMode === "hitl") return "retry";
  if (!item.parentId && item.state === "merge_ready" && item.executionMode === "hitl") return "confirm-merge";
  if (item.state === "done") return "view-result";
  return "view";
}
