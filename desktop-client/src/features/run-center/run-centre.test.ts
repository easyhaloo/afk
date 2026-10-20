import { describe, expect, it } from "vitest";
import { EXECUTION_STATUSES, type ExecutionStatus, type ExecutionSummary } from "../../../shared/execution-contract";
import type { ProjectRun } from "../../../shared/ipc-contract";
import { auditedRunRows, buildRunCentre, filterRunRows, runVisualState, runWorkspacePath } from "./run-centre";

const summary = (status: ExecutionStatus, overrides: Partial<ExecutionSummary> = {}): ExecutionSummary => ({
  runId: `run-${status}`,
  workItemId: "github:acme/api#1",
  profileId: "default",
  attempt: 1,
  status,
  sequence: 1,
  terminal: status === "succeeded" || status === "failed" || status === "cancelled",
  integrityValid: true,
  ...overrides,
});

const legacyRun: ProjectRun = {
  id: "old",
  workItemId: "github:acme/api#1",
  status: "completed",
  startedAt: "2026-09-29T00:00:00Z",
  workspacePath: "/tmp/afk/old",
};

describe("the visual state of a run", () => {
  it("projects every audited status onto its visual state", () => {
    expect(runVisualState("pending")).toBe("ready");
    expect(runVisualState("running")).toBe("active");
    expect(runVisualState("awaiting_human")).toBe("attention");
    expect(runVisualState("succeeded")).toBe("verify");
    expect(runVisualState("failed")).toBe("failed");
    expect(runVisualState("cancelled")).toBe("failed");
  });

  it("projects every status the audited enum declares", () => {
    // A status the table does not know would project as undefined.
    const projected = EXECUTION_STATUSES.map(status => runVisualState(status));
    expect(projected.every(state => typeof state === "string")).toBe(true);
    expect(new Set(projected)).toEqual(new Set(["ready", "active", "verify", "attention", "failed"]));
  });

  it("is a pure function of the audited fields", () => {
    const run = summary("awaiting_human");
    const [first] = auditedRunRows([run], []);
    const [second] = auditedRunRows([run], []);
    expect(first.status).toBe(run.status);
    expect(runVisualState(first.status)).toBe(runVisualState(second.status));
    expect(runVisualState(first.status)).toBe("attention");
  });
});

describe("the header counts and the rows", () => {
  it("counts and lanes read the same rows", () => {
    const executions = [
      summary("running"),
      summary("awaiting_human", { runId: "run-awaiting" }),
      summary("succeeded", { runId: "run-succeeded" }),
      summary("failed", { runId: "run-failed" }),
      summary("cancelled", { runId: "run-cancelled" }),
      summary("pending", { runId: "run-pending" }),
    ];
    const model = buildRunCentre(executions, []);
    expect(model.counts.running).toBe(executions.filter(run => run.status === "running").length);
    expect(model.counts.waiting).toBe(executions.filter(run => run.status === "awaiting_human").length);
    expect(model.counts.failed).toBe(executions.filter(run => run.status === "failed" || run.status === "cancelled").length);
    expect(model.counts.done).toBe(executions.filter(run => run.status === "succeeded").length);
    // The lanes hold exactly the rows the counts count.
    expect(model.lanes.active.length).toBe(model.counts.running);
    expect(model.lanes.attention.length).toBe(model.counts.waiting);
    expect(model.lanes.failed.length).toBe(model.counts.failed);
    expect(model.lanes.verify.length).toBe(model.counts.done);
    // A run that is running is counted as running and shown as running.
    expect(model.lanes.active.map(row => row.id)).toEqual(["run-running"]);
    expect(model.lanes.active[0].status).toBe("running");
  });

  it("counts the token usage of the same rows", () => {
    const model = buildRunCentre([
      summary("running", { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }),
      summary("succeeded", { runId: "run-done", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }),
    ], []);
    expect(model.counts.tokens).toBe(14);
  });
});

describe("a run whose audit chain is broken", () => {
  it("is presented as such and still lands in the right lane", () => {
    const [row] = auditedRunRows([summary("running", { integrityValid: false })], []);
    expect(row.integrityValid).toBe(false);
    expect(row.result).toContain("审计链不完整");
    expect(row.nextStep).toContain("审计链不完整");
    expect(runVisualState(row.status)).toBe("active");
    const model = buildRunCentre([summary("running", { integrityValid: false })], []);
    expect(model.lanes.active.length).toBe(1);
    expect(model.counts.running).toBe(1);
  });
});

describe("the workspace path", () => {
  it("carries the audited workspace path into the row", () => {
    const rows = auditedRunRows([summary("succeeded", { workspacePath: "/tmp/afk/144" })], []);
    expect(runWorkspacePath(rows[0]!)).toBe("/tmp/afk/144");
  });

  it("leaves the row without a path when the summary never recorded one", () => {
    const rows = auditedRunRows([summary("succeeded")], []);
    expect(runWorkspacePath(rows[0]!)).toBeNull();
  });

  it("is read from the row's field, never out of prose", () => {
    const [row] = auditedRunRows([summary("succeeded")], []);
    expect(runWorkspacePath(row)).toBeNull();
    expect(runWorkspacePath({ ...row, workspacePath: "/tmp/afk/144" })).toBe("/tmp/afk/144");
    // A sentence that contains a path is not a path.
    expect(runWorkspacePath({ ...row, nextStep: "任务空间：/tmp/afk/144" })).toBeNull();
  });
});

describe("the legacy snapshot records", () => {
  it("still appear, with their labels and their workspace path", () => {
    const rows = auditedRunRows([summary("running")], [legacyRun]);
    expect(rows.map(row => row.id)).toEqual(["run-running", "work-item-run-old"]);
    expect(rows[1].result).toBe("旧记录：实现进程已退出，QA 未验证");
    expect(runWorkspacePath(rows[1])).toBe("/tmp/afk/old");
  });

  it("take part in the same lanes and the same counts", () => {
    const model = buildRunCentre([summary("running")], [legacyRun]);
    expect(model.lanes.active.length).toBe(1);
    expect(model.lanes.attention.length).toBe(1);
    expect(model.counts.running).toBe(1);
    expect(model.counts.waiting).toBe(1);
  });
});

describe("the run filter", () => {
  it("reads the audited status", () => {
    const rows = auditedRunRows([
      summary("running"),
      summary("awaiting_human", { runId: "run-awaiting" }),
      summary("failed", { runId: "run-failed" }),
      summary("cancelled", { runId: "run-cancelled" }),
      summary("pending", { runId: "run-pending" }),
    ], []);
    expect(filterRunRows(rows, "all").length).toBe(5);
    expect(filterRunRows(rows, "open").map(row => row.id)).toEqual(["run-running", "run-awaiting"]);
    expect(filterRunRows(rows, "fail").map(row => row.id)).toEqual(["run-failed", "run-cancelled"]);
  });
});
