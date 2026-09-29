import { describe, expect, it } from "vitest";
import { executionEvents, executionHistoryEvents } from "../src/features/run-center/execution-events";
import type { ExecutionSummary } from "../shared/execution-contract";

const base: ExecutionSummary = {
  executionId: "execution-158", runId: "afk-run-158", workItemId: "github:easyhaloo/afk#158",
  project: { platform: "github", projectKey: "easyhaloo/afk", name: "afk" },
  status: "implementing", startedAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:01:00Z",
};

describe("audited run center events", () => {
  it("uses execution identity rather than the work item as the event ID", () => {
    const [event] = executionEvents([base, { ...base, executionId: "retry-158", runId: "afk-retry-158", status: "verifying" }]);
    expect(event.id).toBe("execution-158");
    expect(event.source).toBe(base.workItemId);
    expect(event.status).toBe("running");
  });

  it("does not show implementation success or invalid audit as completed", () => {
    const events = executionEvents([
      { ...base, status: "verifying" },
      { ...base, executionId: "unknown-158", status: "unknown", diagnostic: "invalid_hash" },
      { ...base, executionId: "merged-158", status: "done" },
    ]);
    expect(events.map(event => event.status)).toEqual(["running", "waiting_confirmation", "completed"]);
    expect(events[1].result).toContain("审计");
  });
});

describe("work item run history", () => {
  it("does not hide a snapshot record merely because its ID equals an audited execution ID", () => {
    const events = executionHistoryEvents([{ ...base, executionId: "old" }], [
      { id: "old", workItemId: base.workItemId, status: "completed", startedAt: base.startedAt!, workspacePath: "/root" },
    ]);
    expect(events.map(event => event.id)).toEqual(["old", "work-item-run-old"]);
  });
});
