import { describe, expect, it } from "vitest";
import { parseExecutionQueryOptions, parseExecutionSummary } from "../../shared/execution-contract";

const valid = {
  runId: "afk-github:easyhaloo/afk#158-abc",
  workItemId: "github:easyhaloo/afk#158",
  profileId: "default", attempt: 1, status: "running", phase: "verification", sequence: 2, terminal: false,
} as const;

describe("execution summary contract", () => {
  it("parses the application execution projection", () => {
    expect(parseExecutionSummary(valid)).toEqual(valid);
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
