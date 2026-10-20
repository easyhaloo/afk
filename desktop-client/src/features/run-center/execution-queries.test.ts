import { describe, expect, it } from "vitest";
import type { ExecutionSummary } from "../../../shared/execution-contract";
import {
  executionDetailKey,
  executionHistoryKey,
  mergeExecutionPage,
  type ExecutionHistoryState,
} from "./execution-queries";

const workItemId = "github:acme/api#1";
const run = (runId: string, sequence = 1, itemId = workItemId): ExecutionSummary => ({
  runId, workItemId: itemId, profileId: "default", attempt: 1, status: "running", sequence, terminal: false, integrityValid: true,
});
const state = (executions: ExecutionSummary[], extra: Partial<ExecutionHistoryState> = {}): ExecutionHistoryState =>
  ({ executions, paginated: false, ...extra });

describe("execution queries", () => {
  it("keeps the history of every work item apart from the history of one work item", () => {
    expect(executionHistoryKey()).not.toBe(executionHistoryKey(workItemId));
    expect(executionHistoryKey(workItemId)).toBe(executionHistoryKey(workItemId));
    expect(executionDetailKey("afk-1", workItemId)).not.toBe(executionDetailKey("afk-2", workItemId));
    expect(executionDetailKey("afk-1", workItemId)).not.toBe(executionDetailKey("afk-1", "github:acme/api#2"));
  });

  it("lets a refreshed record win over a stale one by sequence", () => {
    const merged = mergeExecutionPage(state([run("latest", 3)]), { executions: [run("latest", 1)] }, "refresh", workItemId);
    expect(merged.executions).toEqual([run("latest", 3)]);
  });

  it("keeps the records a refresh already had", () => {
    const merged = mergeExecutionPage(state([run("latest", 3), run("historical", 1)]), { executions: [run("latest", 4)] }, "refresh", workItemId);
    expect(merged.executions.map(execution => execution.runId)).toEqual(["latest", "historical"]);
    expect(merged.executions[0].sequence).toBe(4);
  });

  it("appends a page and advances the cursor when more is requested", () => {
    const merged = mergeExecutionPage(state([run("latest", 3)], { nextCursor: "older" }), { executions: [run("older", 1)], nextCursor: "oldest" }, "more", workItemId);
    expect(merged.executions.map(execution => execution.runId)).toEqual(["latest", "older"]);
    expect(merged.nextCursor).toBe("oldest");
    expect(merged.paginated).toBe(true);
  });

  it("advances the first-page cursor until pagination starts", () => {
    const first = mergeExecutionPage(state([]), { executions: [run("first")], nextCursor: "older" }, "refresh", workItemId);
    expect(first.nextCursor).toBe("older");
    expect(first.paginated).toBe(false);

    const paginated = mergeExecutionPage(state([run("first")], { nextCursor: "older", paginated: true }), { executions: [run("first")], nextCursor: "changed" }, "refresh", workItemId);
    expect(paginated.nextCursor).toBe("older");
  });

  it("keeps the cursor of a lookup where it is", () => {
    const merged = mergeExecutionPage(state([run("current")], { nextCursor: "older" }), { executions: [run("found")], nextCursor: "oldest" }, "lookup", workItemId);
    expect(merged.executions.map(execution => execution.runId)).toEqual(["current", "found"]);
    expect(merged.nextCursor).toBe("older");
    expect(merged.paginated).toBe(false);
  });

  it("drops the records of another work item", () => {
    const merged = mergeExecutionPage(state([]), { executions: [run("other", 1, "github:acme/api#2")] }, "refresh", workItemId);
    expect(merged.executions).toEqual([]);
  });
});
