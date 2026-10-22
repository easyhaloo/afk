import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RunEventQueryPort } from "@afk/application";
import type { RunEvent, RunEventDraft } from "@afk/core";
import { createWorkItemExecutionQueryService } from "../../electron/services/work-item-execution-query-service.js";

const workItemId = "github:easyhaloo/afk#158";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(entry => entry === undefined ? "null" : stableJson(entry)).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
  entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
}

function sign(draft: RunEventDraft & { sequence: number; observedAt: string }, previous?: RunEvent): RunEvent {
  const integrity = { prevHash: previous?.integrity.hash };
  const hash = createHash("sha256").update(stableJson({ ...draft, integrity })).digest("hex");
  return { ...draft, integrity: { ...integrity, hash } } as RunEvent;
}

function requestedRun(status: "pending" | "succeeded" | "failed" | "cancelled" = "pending", runId = "afk-158", id = workItemId): RunEventDraft {
  return {
    id: "event-1", schemaVersion: 1, type: "run.requested",
    occurredAt: "2026-09-29T00:00:00.000Z",
    correlationId: runId,
    context: { traceId: "trace-1", runId, workItemId: id, profileId: "default", attempt: 1, actor: { kind: "cli", id: "user" } },
    data: { kind: "run.requested", run: { id: runId, workItemId: id, profileId: "default", attempt: 1, status } },
  };
}

function following(previous: RunEvent, index: number, data: RunEventDraft["data"]): RunEventDraft {
  return {
    id: `event-${index + 1}`, schemaVersion: 1, type: data.kind,
    occurredAt: `2026-09-29T00:00:0${index}.000Z`,
    correlationId: previous.correlationId,
    context: previous.context,
    data,
  };
}

function signedChain(drafts: RunEventDraft[]): RunEvent[] {
  const events: RunEvent[] = [];
  let previous: RunEvent | undefined;
  for (const [index, draft] of drafts.entries()) {
    const event = sign({ ...draft, sequence: index + 1, observedAt: draft.occurredAt }, previous);
    events.push(event);
    previous = event;
  }
  return events;
}

function chainOf(drafts: RunEventDraft[]): RunEventDraft[] {
  return drafts.map((draft, index) => index === 0 ? draft : { ...draft, context: drafts[0].context, correlationId: drafts[0].correlationId });
}

function port(events: RunEvent[], integrity: { valid: boolean; reason?: string } = { valid: true }): RunEventQueryPort {
  return {
    listRuns: vi.fn(async () => [...new Set(events.map(item => item.context.runId))]),
    async *read(runId: string) { yield* events.filter(item => item.context.runId === runId); },
    verify: vi.fn(async () => ({ valid: integrity.valid, lastSequence: events.length, ...(integrity.reason ? { reason: integrity.reason } : {}) })),
  };
}

describe("work item execution run detail", () => {
  it("shows only the workflow snapshot recorded for this attempt", async () => {
    const drafts = chainOf([
      requestedRun(),
      following({} as RunEvent, 1, { kind: "workflow.recorded", name: "issue-implementation", version: 1,
        steps: [{ id: "implement", kind: "agent", dependsOn: [], provider: "opencode", executionMode: "interactive" },
          { id: "verify-ac", kind: "agent", dependsOn: ["implement"], provider: "opencode", executionMode: "interactive" }] }),
    ]);
    const detail = await createWorkItemExecutionQueryService(port(signedChain(drafts))).detail("afk-158", workItemId);
    expect(detail.entries[1]).toMatchObject({ kind: "workflow.recorded", reason: expect.stringContaining("issue-implementation v1") });
    expect(detail.entries[1].reason).toContain("verify-ac · agent · opencode · interactive · 依赖 implement");
    expect(detail.workflow).toMatchObject({ name: "issue-implementation", steps: [{ id: "implement", status: "pending" }, { id: "verify-ac", dependsOn: ["implement"] }] });
    expect(detail.health?.state).toBe("unknown");
  });
  it("keeps stale runtime health independent from a running audit state", async () => {
    const events = signedChain(chainOf([requestedRun(), following({} as RunEvent, 1, { kind: "run.started" })]));
    const now = Date.parse("2026-10-15T01:00:00Z");
    const service = createWorkItemExecutionQueryService(port(events), {
      now: () => now,
      read: async runId => ({ runId, observedAt: new Date(now).toISOString(), status: "running", heartbeatAt: "2026-10-15T00:00:00Z" }),
    });
    expect(await service.detail("afk-158", workItemId)).toMatchObject({ status: "running", health: { state: "stale" } });
  });
  it("reports the replayed aggregate status and latest phase across running -> verification -> succeeded", async () => {
    const drafts: RunEventDraft[] = chainOf([
      requestedRun(),
      following({} as RunEvent, 1, { kind: "run.started" }),
      following({} as RunEvent, 2, { kind: "step.started", stepId: "implement", phase: "implementation" }),
      following({} as RunEvent, 3, { kind: "step.completed", stepId: "implement", outcome: "succeeded" }),
      following({} as RunEvent, 4, { kind: "step.started", stepId: "qa", phase: "verification" }),
      following({} as RunEvent, 5, { kind: "step.completed", stepId: "qa", outcome: "succeeded" }),
      following({} as RunEvent, 6, { kind: "run.finished", outcome: "succeeded" }),
    ]);
    const service = createWorkItemExecutionQueryService(port(signedChain(drafts)));
    const detail = await service.detail("afk-158", workItemId);
    expect(detail.status).toBe("succeeded");
    expect(detail.phase).toBe("verification");
    expect(detail.entries).toHaveLength(7);
    expect(detail.entries[3]).toMatchObject({ kind: "step.completed", outcome: "succeeded" });
  });

  it("preserves step.completed and effect.completed outcomes and human gate reason", async () => {
    const drafts: RunEventDraft[] = chainOf([
      requestedRun(),
      following({} as RunEvent, 1, { kind: "run.started" }),
      following({} as RunEvent, 2, { kind: "step.started", stepId: "qa", phase: "verification" }),
      following({} as RunEvent, 3, { kind: "step.completed", stepId: "qa", outcome: "succeeded" }),
      following({} as RunEvent, 4, { kind: "effect.completed", effectKind: "publish", idempotencyKey: "k1", outcome: "failed", summary: "推送被拒绝" }),
      following({} as RunEvent, 5, { kind: "human_gate.opened", gateId: "gate-1", reason: "需要人工确认 PR" }),
    ]);
    const service = createWorkItemExecutionQueryService(port(signedChain(drafts)));
    const detail = await service.detail("afk-158", workItemId);
    expect(detail.status).toBe("awaiting_human");
    expect(detail.entries[3]).toMatchObject({ kind: "step.completed", stepId: "qa", outcome: "succeeded" });
    expect(detail.entries[4]).toMatchObject({ kind: "effect.completed", outcome: "failed", failureSummary: "推送被拒绝" });
    expect(detail.entries[5]).toMatchObject({ kind: "human_gate.opened", reason: "需要人工确认 PR" });
  });

  it("keeps a cancelled run cancelled, never failed", async () => {
    const drafts: RunEventDraft[] = chainOf([
      requestedRun(),
      following({} as RunEvent, 1, { kind: "run.started" }),
      following({} as RunEvent, 2, { kind: "step.started", stepId: "implement", phase: "implementation" }),
      following({} as RunEvent, 3, { kind: "step.completed", stepId: "implement", outcome: "succeeded" }),
      following({} as RunEvent, 4, { kind: "run.finished", outcome: "cancelled", reason: "用户取消" }),
    ]);
    const service = createWorkItemExecutionQueryService(port(signedChain(drafts)));
    const detail = await service.detail("afk-158", workItemId);
    expect(detail.status).toBe("cancelled");
    expect(detail.entries[4]).toMatchObject({ kind: "run.finished", outcome: "cancelled", reason: "用户取消" });
  });

  it("rejects a signed but transition-invalid stream through replayRun", async () => {
    const drafts: RunEventDraft[] = chainOf([
      requestedRun(),
      following({} as RunEvent, 1, { kind: "run.finished", outcome: "succeeded" }),
    ]);
    const service = createWorkItemExecutionQueryService(port(signedChain(drafts)));
    await expect(service.detail("afk-158", workItemId)).rejects.toThrow(/cannot be replayed/);
  });

  it("rejects mixed work-item events even when every hash is valid", async () => {
    const drafts: RunEventDraft[] = chainOf([
      requestedRun(),
      following({} as RunEvent, 1, { kind: "run.started" }),
    ]);
    const chain = signedChain(drafts);
    const mixed = { ...chain[1], id: "event-foreign", context: { ...chain[1].context, workItemId: "github:easyhaloo/afk#999" } };
    mixed.integrity = sign({ ...mixed, sequence: 2, observedAt: mixed.occurredAt }, chain[0]).integrity;
    const service = createWorkItemExecutionQueryService(port([chain[0], mixed]));
    await expect(service.detail("afk-158", workItemId)).rejects.toThrow(/contains events for work item/);
  });

  it("rejects a requested payload naming another work item", async () => {
    const drafts: RunEventDraft[] = [requestedRun("pending", "afk-158", "github:easyhaloo/afk#999")];
    const service = createWorkItemExecutionQueryService(port(signedChain(drafts)));
    await expect(service.detail("afk-158", workItemId)).rejects.toThrow(/no recorded events/);
  });

  it("rejects an empty run without fabricating entries", async () => {
    const service = createWorkItemExecutionQueryService(port([]));
    await expect(service.detail("afk-404", workItemId)).rejects.toThrow(/no recorded events/);
  });
});
