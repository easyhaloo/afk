import { describe, expect, it, vi } from "vitest";

/**
 * The desktop's wire contract and its snapshot schema are two halves of
 * one answer: the contract describes the payload, the schema validates
 * what arrives. Every vocabulary they share was written down in both.
 *
 * This test grows a vocabulary the contract publishes and then asks the
 * schema whether it grew with it. A schema that keeps its own copy
 * refuses a payload the contract describes, and the board stops with
 * what it was sent.
 */
vi.mock("../../shared/ipc-contract", async importOriginal => {
  const original = await importOriginal<typeof import("../../shared/ipc-contract")>();
  const states = [...original.LOOP_STATES, "paused"];
  return {
    ...original,
    LOOP_STATES: states,
  };
});

import { LOOP_STATES } from "../../shared/ipc-contract";
import { parseSnapshot } from "../../shared/snapshot-schema";

function snapshotWithLoopState(state: string) {
  return {
    workspace: { root: "/workspace", afkDirectoryPresent: true, eventCount: 0 },
    afk: { available: true, executable: "in-process", summary: "ready" },
    capabilities: [],
    workflow: {
      configPath: "/workspace/.afk/config.yml",
      source: "project",
      agentDefault: "claude-code",
      tmuxSession: "afk",
      targetBranch: "main",
      baseBranch: "main",
      maxRetries: 1,
      hardTimeoutMs: 1000,
      completionTimeoutMs: 1000,
      contextThreshold: 1000,
      goalBudget: 1000,
      codex: { transport: "auto", auth: "auto", provider: "auto", startupTimeoutMs: 1000 },
      canvasNodes: [],
    },
    workflowTemplates: [],
    workflowRuns: [],
    loop: { state, execution: { active: 0, ids: [] }, totals: { completed: 0, failed: 0 }, lastError: {} },
    agentRuntimes: [],
    workItemRuns: [],
    containers: [],
    sessions: [],
    resources: [],
    graph: { state: "missing", templateId: "t", diagnostics: [] },
  };
}

describe("the desktop's schema reads the vocabularies its contract publishes", () => {
  it("accepts every loop state the contract declares", () => {
    for (const state of LOOP_STATES) {
      expect(parseSnapshot(snapshotWithLoopState(state)).loop.state).toBe(state);
    }
  });

  it("refuses a loop state the contract does not declare", () => {
    expect(() => parseSnapshot(snapshotWithLoopState("quantum"))).toThrow();
  });
});
