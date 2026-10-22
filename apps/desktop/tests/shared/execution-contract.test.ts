import { describe, expect, it } from "vitest";
import { parseExecutionQueryOptions, parseExecutionSummary } from "../../shared/execution-contract.js";

const valid = {
  runId: "afk-github:easyhaloo/afk#158-abc",
  workItemId: "github:easyhaloo/afk#158",
  profileId: "default", attempt: 1, status: "running", phase: "verification", sequence: 2, terminal: false,
} as const;

describe("execution summary contract", () => {
  it("parses the application execution projection", () => {
    expect(parseExecutionSummary(valid)).toEqual(valid);
  });

  it("accepts recorded start times while preserving older summaries", () => {
    const startedAt = "2026-10-19T12:16:17.270Z";
    expect(parseExecutionSummary({ ...valid, startedAt })).toEqual({ ...valid, startedAt });
    expect(parseExecutionSummary(valid)).not.toHaveProperty("startedAt");
    for (const invalid of ["", "invalid-time", 123, null]) {
      expect(() => parseExecutionSummary({ ...valid, startedAt: invalid })).toThrow(/startedAt/);
    }
  });

  it("preserves recorded token usage, including a real zero", () => {
    for (const usage of [{ inputTokens: 10, outputTokens: 2, totalTokens: 12 }, { inputTokens: 0, outputTokens: 0, totalTokens: 0 }]) {
      expect(parseExecutionSummary({ ...valid, usage })).toEqual({ ...valid, usage });
    }
    expect(parseExecutionSummary(valid)).not.toHaveProperty("usage");
  });

  it.each([
    null,
    { inputTokens: -1, outputTokens: 2, totalTokens: 1 },
    { inputTokens: 1.5, outputTokens: 2, totalTokens: 3.5 },
    { inputTokens: NaN, outputTokens: 2, totalTokens: NaN },
    { inputTokens: Infinity, outputTokens: 2, totalTokens: Infinity },
    { inputTokens: "10", outputTokens: 2, totalTokens: 12 },
    { inputTokens: 10, totalTokens: 12 },
    { inputTokens: 10, outputTokens: 2, totalTokens: 13 },
    { inputTokens: 10, outputTokens: 2, totalTokens: 12, transcript: "private" },
  ])("rejects invalid or excessive usage data: %j", usage => {
    expect(() => parseExecutionSummary({ ...valid, usage })).toThrow(/usage/);
  });

  it("rejects missing run identity", () => {
    expect(() => parseExecutionSummary({ ...valid, runId: "" })).toThrow();
  });

  it("rejects unknown statuses, invalid counters and untrusted extra fields", () => {
    expect(() => parseExecutionSummary({ ...valid, status: "completed" })).toThrow();
    expect(() => parseExecutionSummary({ ...valid, sequence: -1 })).toThrow();
    expect(() => parseExecutionSummary({ ...valid, token: "secret" })).toThrow();
  });

  it("does not invent fields not exposed by the application", () => {
    const { phase: _phase, ...withoutPhase } = valid;
    expect(parseExecutionSummary({ ...valid, phase: undefined })).toEqual(withoutPhase);
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
