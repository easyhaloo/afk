import { describe, expect, it } from "vitest";
import {
  BACKLOG_STATES,
  BACKLOG_EXECUTION_MODES,
  type BacklogItem,
  type BacklogState,
  type BacklogExecutionMode,
  type BacklogListOptions,
  type BacklogPlatform,
  type BacklogError,
  parseBacklogListOptions,
  parseBacklogCreateInput,
  parseBacklogPlatform,
  parseBacklogRunRetryInput,
  parseBacklogRuntimeSummary,
  parseWorkItemRunStartInput,
  parseWorkItemInventoryResult,
} from "../../shared/backlog-contract";

describe("Backlog shared contract", () => {
  it("exports the canonical state and mode unions", () => {
    expect(BACKLOG_STATES).toEqual([
      "ready", "rework", "in_progress", "verification", "merge_ready", "done", "blocked",
    ]);
    expect(BACKLOG_EXECUTION_MODES).toEqual(["afk", "hitl"]);
  });

  it("does not leak secret material through BacklogItem DTO", () => {
    const item: BacklogItem = {
      id: "42",
      title: "demo",
      description: "demo body",
      parentId: undefined,
      baseBacklogId: undefined,
      dependsOn: [],
      state: "ready",
      executionMode: "afk",
      tags: ["billing"],
      branchName: "afk/backlog-42",
      providerRef: "stub:42",
      webUrl: "https://example/42",
    };
    expect(item).not.toHaveProperty("token");
    expect(item).not.toHaveProperty("password");
  });

  it("parseBacklogListOptions returns an empty object for empty input", () => {
    expect(parseBacklogListOptions({})).toEqual({});
  });

  it("parseBacklogListOptions accepts valid options and rejects unknown keys", () => {
    const parsed = parseBacklogListOptions({ state: "ready", tag: "billing", platform: "github" });
    expect(parsed).toEqual({ state: "ready", tag: "billing", platform: "github" });
    expect(() => parseBacklogListOptions({ state: "nope" })).toThrow();
    expect(() => parseBacklogListOptions({ unknown: 1 })).toThrow(/unknown/i);
  });

  it("parseBacklogListOptions enforces enum membership", () => {
    expect(() => parseBacklogListOptions({ state: "ghost" as BacklogState })).toThrow(/state/i);
    expect(() => parseBacklogListOptions({ executionMode: "manual" as BacklogExecutionMode })).toThrow(/mode/i);
  });

  it("parseBacklogCreateInput rejects empty title and description", () => {
    expect(() => parseBacklogCreateInput({ title: "", description: "x" })).toThrow(/title/i);
    expect(() => parseBacklogCreateInput({ title: "x", description: "" })).toThrow(/description/i);
  });

  it("strictly parses retry inputs", () => {
    expect(parseBacklogRunRetryInput({ backlogId: " feature/auth ", reason: " fixed ", template: "feature-delivery" })).toEqual({
      backlogId: "feature/auth",
      reason: "fixed",
      template: "feature-delivery",
    });
    expect(() => parseBacklogRunRetryInput({ backlogId: "42", reason: "" })).toThrow(/reason/i);
    expect(() => parseBacklogRunRetryInput({ backlogId: "42", reason: "fixed", command: "rm -rf /" })).toThrow(/unknown/i);
    expect(() => parseBacklogRunRetryInput({ backlogId: "42\n--help", reason: "fixed" })).toThrow(/backlogId/i);
  });

  it("strictly parses workspace-independent work item run inputs", () => {
    expect(parseWorkItemRunStartInput({
      workItemId: "WI-2026-018",
      repositories: [{ platform: "github", projectKey: "acme/api", name: "api", role: "primary" }],
      workflow: "standard-development",
      environment: "local",
    })).toEqual({
      workItemId: "WI-2026-018",
      repositories: [{ platform: "github", projectKey: "acme/api", name: "api", role: "primary" }],
      workflow: "standard-development",
      environment: "local",
    });
    expect(() => parseWorkItemRunStartInput({ workItemId: "../task", repositories: [] })).toThrow(/workItemId/i);
    expect(() => parseWorkItemRunStartInput({ workItemId: "WI-1", repositories: [], workspace: "/tmp/repo" })).toThrow(/unknown/i);
  });

  it("parseBacklogPlatform only accepts github or gitlab", () => {
    expect(parseBacklogPlatform("github")).toBe("github");
    expect(parseBacklogPlatform("gitlab")).toBe("gitlab");
    expect(parseBacklogPlatform(undefined)).toBeUndefined();
    expect(() => parseBacklogPlatform("bitbucket" as BacklogPlatform)).toThrow(/platform/i);
  });

  it("BacklogError round-trips through JSON", () => {
    const error: BacklogError = { code: "auth", message: "missing token", details: { hint: "GITHUB_TOKEN" } };
    expect(JSON.parse(JSON.stringify(error))).toEqual(error);
  });

  it("parses a runtime summary with optional run sources", () => {
    const summary = parseBacklogRuntimeSummary({
      backlogId: "42",
      backlog: { id: "42", title: "demo", dependsOn: [], state: "ready", executionMode: "afk", tags: [], branchName: "afk/backlog-42", providerRef: "stub:42" },
      runtime: { runId: "run-42", status: "running", phase: "implementing", heartbeatAt: "2026-09-15T00:00:00.000Z" },
    });
    expect(summary.runtime?.status).toBe("running");
    expect(summary.activeRun).toBeUndefined();
  });

  it("rejects unknown fields, mismatched IDs, and invalid runtime states", () => {
    const backlog = { id: "42", title: "demo", dependsOn: [], state: "ready", executionMode: "afk", tags: [], branchName: "afk/backlog-42", providerRef: "stub:42" };
    expect(() => parseBacklogRuntimeSummary({ backlogId: "42", backlog, extra: true })).toThrow(/unknown/i);
    expect(() => parseBacklogRuntimeSummary({ backlogId: "43", backlog })).toThrow(/match/i);
    expect(() => parseBacklogRuntimeSummary({ backlogId: "42", backlog, activeRun: { id: "run", backlogId: "43", status: "running", startedAt: "now" } })).toThrow(/activeRun/i);
    expect(() => parseBacklogRuntimeSummary({ backlogId: "42", backlog, runtime: { runId: "run", status: "pending", phase: "implementing", heartbeatAt: "now" } })).toThrow(/status/i);
  });

  it("strictly parses a global work-item inventory", () => {
    const result = parseWorkItemInventoryResult({
      items: [{ id: "github:acme/api#1", issueNumber: 1, project: { platform: "github", projectKey: "acme/api", name: "api" }, title: "demo", description: "## Goal\n\n- keep markdown", managed: true, executionEligible: true, state: "ready", executionMode: "afk", dependsOn: [], tags: [], branchName: "afk/backlog-1", providerRef: "github:acme/api#1" }],
      projects: [{ platform: "github", projectKey: "acme/api", name: "api" }],
      diagnostics: [],
      complete: true,
    });
    expect(result.items[0].id).toBe("github:acme/api#1");
    expect(result.items[0].description).toContain("\n");
    expect(() => parseWorkItemInventoryResult({ ...result, workspace: "/repo" })).toThrow(/unknown/i);
  });
});
