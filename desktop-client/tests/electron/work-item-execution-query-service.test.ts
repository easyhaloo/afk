import { describe, expect, it, vi } from "vitest";
import { createWorkItemExecutionQueryService } from "../../electron/services/work-item-execution-query-service";

const summary = {
  executionId: "execution-158",
  runId: "afk-158",
  workItemId: "github:easyhaloo/afk#158",
  status: "verifying",
  startedAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:01:00.000Z",
};

describe("work item execution query", () => {
  it("requests bounded audit records and projects their exact provider identity", async () => {
    const run = vi.fn(async () => JSON.stringify({ executions: [summary], nextCursor: "afk-158" }));
    const query = createWorkItemExecutionQueryService({ run });
    const page = await query.list({ workItemId: summary.workItemId, limit: 25 });
    expect(run).toHaveBeenCalledWith(["observe", "executions", "--work-item-id", summary.workItemId, "--limit", "25", "--json"]);
    expect(page.nextCursor).toBe("afk-158");
    expect(page.executions[0]).toMatchObject({ workItemId: summary.workItemId, project: { platform: "github", projectKey: "easyhaloo/afk" }, status: "verifying" });
  });

  it("queries all recent executions and rejects an unrelated issue in a scoped reply", async () => {
    const run = vi.fn(async () => JSON.stringify({ executions: [summary] }));
    const query = createWorkItemExecutionQueryService({ run });
    expect((await query.list({ limit: 10 })).executions).toHaveLength(1);
    expect(run).toHaveBeenCalledWith(["observe", "executions", "--limit", "10", "--json"]);
    await expect(query.list({ workItemId: "github:other/repo#158" })).rejects.toThrow(/work item/i);
  });

  it("keeps an audit integrity failure unknown without fabricating timestamps", async () => {
    const { startedAt: _startedAt, updatedAt: _updatedAt, ...unknown } = summary;
    const query = createWorkItemExecutionQueryService({ run: async () => JSON.stringify({ executions: [{ ...unknown, status: "unknown", diagnostic: "invalid_hash" }] }) });
    expect((await query.list()).executions[0]).toMatchObject({ status: "unknown", diagnostic: "invalid_hash" });
  });

  it("keeps valid executions visible when a corrupt stream has no verifiable identity", async () => {
    const query = createWorkItemExecutionQueryService({ run: async () => JSON.stringify({ executions: [
      { executionId: "corrupt", runId: "corrupt", workItemId: "", status: "unknown", diagnostic: "integrity_mismatch" },
      summary,
    ] }) });
    expect((await query.list()).executions.map(execution => execution.executionId)).toEqual(["execution-158"]);
  });
});
