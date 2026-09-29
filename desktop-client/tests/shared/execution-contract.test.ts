import { describe, expect, it } from "vitest";
import { parseExecutionQueryOptions, parseExecutionSummary } from "../../shared/execution-contract";

const valid = {
  executionId: "afk-github:easyhaloo/afk#158-abc",
  workItemId: "github:easyhaloo/afk#158",
  project: { platform: "github", projectKey: "easyhaloo/afk", name: "afk" },
  status: "verifying",
  startedAt: "2026-09-29T00:00:00.000Z",
  updatedAt: "2026-09-29T00:01:00.000Z",
} as const;

describe("execution summary contract", () => {
  it("parses a canonical attempt and its published change request", () => {
    expect(parseExecutionSummary({
      ...valid,
      status: "awaiting_merge",
      pr: { id: "159", url: "https://github.com/easyhaloo/afk/pull/159", state: "open" },
    })).toMatchObject({ workItemId: valid.workItemId, pr: { id: "159" } });
  });

  it("rejects a different project even when the issue number matches", () => {
    expect(() => parseExecutionSummary({
      ...valid,
      project: { platform: "github", projectKey: "other/repo", name: "repo" },
    })).toThrow();
  });

  it("rejects unknown statuses, invalid timestamps and untrusted extra fields", () => {
    expect(() => parseExecutionSummary({ ...valid, status: "completed" })).toThrow();
    expect(() => parseExecutionSummary({ ...valid, updatedAt: "yesterday" })).toThrow();
    expect(() => parseExecutionSummary({ ...valid, token: "secret" })).toThrow();
  });

  it("keeps a missing audit stream unknown without inventing timestamps", () => {
    const { startedAt: _startedAt, updatedAt: _updatedAt, ...summary } = valid;
    expect(parseExecutionSummary({ ...summary, status: "unknown", diagnostic: "missing_stream" })).toEqual({
      ...summary, status: "unknown", diagnostic: "missing_stream",
    });
  });
});

describe("execution query options", () => {
  it("accepts a bounded global or exact work-item query", () => {
    expect(parseExecutionQueryOptions({ limit: 25 })).toEqual({ limit: 25 });
    expect(parseExecutionQueryOptions({ workItemId: "github:easyhaloo/afk#158", since: "afk-run-1" })).toEqual({ workItemId: "github:easyhaloo/afk#158", since: "afk-run-1" });
  });

  it("rejects ambiguous identity and unbounded or unknown input", () => {
    expect(() => parseExecutionQueryOptions({ workItemId: "158" })).toThrow();
    expect(() => parseExecutionQueryOptions({ limit: 1000 })).toThrow();
    expect(() => parseExecutionQueryOptions({ shell: "rm -rf" })).toThrow();
  });
});
