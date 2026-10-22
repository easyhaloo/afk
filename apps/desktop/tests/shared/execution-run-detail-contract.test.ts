import { describe, expect, it } from "vitest";
import { parseExecutionRunDetail, parseExecutionTimelineEntry, parseRuntimeHealth, parseWorkflowInstance } from "../../shared/execution-contract.js";

describe("execution run detail contract", () => {
  it("validates health and instance DTOs at the preload boundary", () => {
    expect(parseRuntimeHealth({ state: "stale", observedAt: "2026-10-15T00:00:00Z", reason: "心跳过期" }).state).toBe("stale");
    expect(() => parseRuntimeHealth({ state: "live", observedAt: "invalid", reason: "invalid" })).toThrow();
    expect(() => parseRuntimeHealth({ state: "live", observedAt: "2026-10-15T00:00:00Z", reason: "invalid", runnerPid: 1.5 })).toThrow();
    expect(() => parseWorkflowInstance({ name: "recorded", version: 1, recordedAt: "2026-10-15T00:00:00Z", steps: [{ id: "a", kind: "agent", status: "running", dependsOn: ["other"] }] })).toThrow(/dependencies/);
  });
  it("parses a valid timeline entry", () => {
    const entry = parseExecutionTimelineEntry({
      sequence: 2, occurredAt: "2026-09-29T00:00:01.000Z", kind: "workspace.prepared",
      workspacePath: "/tmp/ws", workspaceBranch: "afk/task",
    });
    expect(entry).toEqual({
      sequence: 2, occurredAt: "2026-09-29T00:00:01.000Z", kind: "workspace.prepared",
      workspacePath: "/tmp/ws", workspaceBranch: "afk/task",
    });
  });

  it("rejects unknown entry kinds instead of rendering them", () => {
    expect(() => parseExecutionTimelineEntry({ sequence: 1, occurredAt: "2026-09-29T00:00:00.000Z", kind: "mystery.event" })).toThrow(/kind/);
  });

  it("rejects unknown fields on entries and details", () => {
    expect(() => parseExecutionTimelineEntry({ sequence: 1, occurredAt: "2026-09-29T00:00:00.000Z", kind: "run.started", fabricated: true })).toThrow(/unknown field/);
    expect(() => parseExecutionRunDetail({ runId: "r", workItemId: "github:o/r#1", status: "pending", integrityValid: true, entries: [], extra: 1 })).toThrow(/unknown field/);
  });

  it("parses a full run detail payload", () => {
    const detail = parseExecutionRunDetail({
      runId: "afk-158", workItemId: "github:easyhaloo/afk#158", status: "failed", phase: "verification",
      integrityValid: true, integrityReason: undefined,
      entries: [{ sequence: 1, occurredAt: "2026-09-29T00:00:00.000Z", kind: "run.started" }],
    });
    expect(detail.status).toBe("failed");
    expect(detail.entries).toHaveLength(1);
  });
});
