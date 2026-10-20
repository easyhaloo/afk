import { describe, expect, it } from "vitest";
import { getBacklogPrimaryAction } from "../src/features/backlog/backlog-primary-action";
import type { BacklogItem, BacklogRunSummary } from "../shared/backlog-contract";

const ready: BacklogItem = {
  id: "1", title: "登录态切换", dependsOn: [], state: "ready", executionMode: "afk",
  tags: ["billing"], branchName: "afk/backlog-1", providerRef: "stub:1",
};

const activeRun: BacklogRunSummary = {
  id: "run-1", backlogId: ready.id, status: "running", startedAt: "2026-09-17T08:00:00.000Z", pid: 1234,
};

describe("the backlog list's primary action", () => {
  it("selects exactly one primary action from provider, runtime, and local process state", () => {
    expect(getBacklogPrimaryAction(ready)).toBe("start");
    expect(getBacklogPrimaryAction(ready, { backlogId: ready.id, backlog: ready, activeRun })).toBe("view-run");
    expect(getBacklogPrimaryAction({ ...ready, state: "in_progress" }, { backlogId: ready.id, backlog: { ...ready, state: "in_progress" }, activeRun })).toBe("stop");
    expect(getBacklogPrimaryAction({ ...ready, state: "verification" }, { backlogId: ready.id, backlog: { ...ready, state: "verification" }, runtime: { runId: "runtime-1", status: "running", phase: "verifying", heartbeatAt: "2026-09-17T08:00:00.000Z" } })).toBe("view-run");
    expect(getBacklogPrimaryAction({ ...ready, state: "in_progress" }, { backlogId: ready.id, backlog: { ...ready, state: "in_progress" }, runtime: { runId: "runtime-1", status: "stale", phase: "implementing", heartbeatAt: "2026-09-17T07:00:00.000Z" } })).toBe("recover");
    expect(getBacklogPrimaryAction({ ...ready, state: "blocked", executionMode: "hitl" })).toBe("retry");
    expect(getBacklogPrimaryAction({ ...ready, state: "merge_ready", executionMode: "hitl" })).toBe("confirm-merge");
    expect(getBacklogPrimaryAction({ ...ready, parentId: "parent-1", state: "merge_ready", executionMode: "hitl" })).toBe("view");
    expect(getBacklogPrimaryAction({ ...ready, state: "done", executionMode: "hitl" })).toBe("view-result");
  });

  it("offers a start for a work item in rework, and a retry only in hitl", () => {
    expect(getBacklogPrimaryAction({ ...ready, state: "rework" })).toBe("start");
    expect(getBacklogPrimaryAction({ ...ready, state: "blocked", executionMode: "afk" })).toBe("view");
  });
});
