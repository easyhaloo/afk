import { describe, expect, it, vi } from "vitest";

/**
 * The phases a task runtime record can be in are a vocabulary with one
 * owner: the core package, which the desktop's renderer can load. The
 * desktop reads those records, and the board reads them too, so both have
 * to read the owner's list rather than keeping their own.
 *
 * This test grows the vocabulary the core package publishes and then
 * asks the desktop whether it grew with it. A reader that keeps its own
 * copy refuses the new value, and that refusal is the defect.
 */
vi.mock("@afk/core", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/core")>();
  return {
    ...original,
    TASK_RUNTIME_PHASES: [...original.TASK_RUNTIME_PHASES, "handover"],
  };
});

import { TASK_RUNTIME_PHASES } from "@afk/core";
import { parseBacklogRuntimeSummary } from "../../desktop-client/shared/backlog-contract";

function backlog() {
  return {
    id: "42",
    title: "demo",
    description: "demo",
    dependsOn: [],
    state: "ready" as const,
    executionMode: "afk" as const,
    tags: [],
    branchName: "afk/backlog-42",
    providerRef: "stub:42",
  };
}

describe("The desktop reads the phases the core package publishes", () => {
  it("reads every phase the core package declares", () => {
    for (const phase of TASK_RUNTIME_PHASES) {
      const parsed = parseBacklogRuntimeSummary({
        backlogId: "42",
        backlog: backlog(),
        runtime: { runId: "run-1", status: "running", phase, heartbeatAt: "2026-09-15T00:00:00.000Z" },
      });
      expect(parsed.runtime?.phase).toBe(phase);
    }
  });

  it("refuses a phase the core package does not declare", () => {
    expect(() => parseBacklogRuntimeSummary({
      backlogId: "42",
      backlog: backlog(),
      runtime: { runId: "run-1", status: "running", phase: "quantum", heartbeatAt: "2026-09-15T00:00:00.000Z" },
    })).toThrow(/phase/i);
  });
});
