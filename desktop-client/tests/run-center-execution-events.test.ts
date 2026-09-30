import { describe, expect, it } from "vitest";
import { executionEvents, executionHistoryEvents } from "../src/features/run-center/execution-events";
import type { ExecutionSummary } from "../shared/execution-contract";

const base: ExecutionSummary = {
  runId: "afk-run-158", workItemId: "github:easyhaloo/afk#158",
  profileId: "default", attempt: 1, status: "running", phase: "implementation", sequence: 2, terminal: false,
};

describe("audited run center events", () => {
  it("uses execution identity rather than the work item as the event ID", () => {
    const [event] = executionEvents([base, { ...base, runId: "afk-retry-158" }]);
    expect(event.id).toBe(base.runId);
    expect(event.source).toBe(base.workItemId);
    expect(event.status).toBe("running");
  });

  it("does not show implementation success or invalid audit as completed", () => {
    const events = executionEvents([
      { ...base, status: "running" },
      { ...base, runId: "pending-158", status: "awaiting_human" },
      { ...base, runId: "done-158", status: "succeeded" },
    ]);
    expect(events.map(event => event.status)).toEqual(["running", "waiting_confirmation", "completed"]);
    expect(events[1].result).toContain("人工");
  });
});

describe("work item run history", () => {
  it("does not hide a snapshot record merely because its ID equals an audited execution ID", () => {
    const events = executionHistoryEvents([{ ...base, runId: "old" }], [
      { id: "old", workItemId: base.workItemId, status: "completed", startedAt: "2026-09-29T00:00:00Z", workspacePath: "/root" },
    ]);
    expect(events.map(event => event.id)).toEqual(["old", "work-item-run-old"]);
  });
});
