import { describe, expect, it, vi } from "vitest";
import type { RunEventQueryPort } from "@afk/application";
import type { RunEvent } from "@afk/core";
import { createWorkItemExecutionQueryService } from "../../electron/services/work-item-execution-query-service";

const event: RunEvent = {
  id: "event-1", schemaVersion: 1, type: "run.requested", sequence: 1,
  occurredAt: "2026-09-29T00:00:00.000Z", observedAt: "2026-09-29T00:00:00.000Z",
  correlationId: "afk-158",
  context: { traceId: "trace-1", runId: "afk-158", workItemId: "github:easyhaloo/afk#158", profileId: "default", attempt: 1, actor: { kind: "cli", id: "user" } },
  data: { kind: "run.requested", run: { id: "afk-158", workItemId: "github:easyhaloo/afk#158", profileId: "default", attempt: 1, status: "pending" } },
  integrity: { hash: "test-hash" },
};

function port(events: RunEvent[] = [event]): RunEventQueryPort {
  return {
    listRuns: vi.fn(async () => [...new Set(events.map(item => item.context.runId))]),
    async *read(runId: string) { yield* events.filter(item => item.context.runId === runId); },
    verify: vi.fn(async () => ({ valid: true, lastSequence: events.length })),
  };
}

describe("work item execution query", () => {
  it("runs the application use case over the injected EventStore without a CLI", async () => {
    const events = port();
    const page = await createWorkItemExecutionQueryService(events).list({ workItemId: event.context.workItemId, limit: 25 });
    expect(events.listRuns).toHaveBeenCalledOnce();
    expect(page).toEqual({ executions: [{ runId: "afk-158", workItemId: event.context.workItemId, profileId: "default", attempt: 1, status: "pending", sequence: 1, terminal: false }] });
  });

  it("uses the application filter and cursor semantics", async () => {
    const query = createWorkItemExecutionQueryService(port());
    expect((await query.list({ workItemId: "github:other/repo#158" })).executions).toEqual([]);
    await expect(query.list({ since: "absent" })).rejects.toThrow(/cursor/);
  });

  it("rejects unbounded query input", async () => {
    await expect(createWorkItemExecutionQueryService(port()).list({ limit: 101 })).rejects.toThrow(/limit/);
  });
});
