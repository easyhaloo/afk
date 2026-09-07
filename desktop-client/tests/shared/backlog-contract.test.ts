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
});
