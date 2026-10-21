import { describe, expect, it, vi } from "vitest";

/**
 * The kinds a workflow step can be are a vocabulary with one owner: the
 * core package, where the audit spine records them. The template schema
 * validates one, the application projects one, and the desktop reads
 * one, so all of them have to read the owner's list.
 *
 * This test grows the vocabulary the core package publishes and then
 * asks the readers whether they grew with it. A reader that keeps its
 * own copy refuses the new value, and that refusal is the defect.
 */
vi.mock("@afk/core", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/core")>();
  const kinds = [...original.WORKFLOW_STEP_KINDS, "tool"];
  return {
    ...original,
    WORKFLOW_STEP_KINDS: kinds,
    isWorkflowStepKind: (value: unknown) => kinds.includes(value as never),
  };
});

import { WORKFLOW_STEP_KINDS } from "@afk/core";
import { parseWorkflowInstance } from "../../desktop-client/shared/execution-contract";
import { parseSnapshot } from "../../desktop-client/shared/snapshot-schema";

function snapshotWithStepKind(kind: string) {
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
    workflowTemplates: [{
      id: "template",
      name: "template",
      label: "Template",
      source: "project",
      description: "A template",
      steps: [{ id: "implement", role: "implementer", prompt: "hi", kind, dependsOn: [] }],
      provider: "claude-code",
      phase: "implementation",
    }],
    workflowRuns: [],
    loop: { state: "stopped", execution: { active: 0, ids: [] }, totals: { completed: 0, failed: 0 }, lastError: {} },
    agentRuntimes: [],
    workItemRuns: [],
    containers: [],
    sessions: [],
    resources: [],
    graph: { state: "missing", templateId: "t", diagnostics: [] },
  };
}

describe("The desktop reads the step kinds the core package publishes", () => {
  it("reads every step kind the core package declares", () => {
    for (const kind of WORKFLOW_STEP_KINDS) {
      const parsed = parseWorkflowInstance({
        name: "workflow",
        version: 1,
        recordedAt: "2026-09-15T00:00:00.000Z",
        steps: [{ id: "implement", kind, dependsOn: [], status: "pending" }],
      });
      expect(parsed.steps[0]?.kind).toBe(kind);
    }
  });

  it("refuses a step kind the core package does not declare", () => {
    expect(() => parseWorkflowInstance({
      name: "workflow",
      version: 1,
      recordedAt: "2026-09-15T00:00:00.000Z",
      steps: [{ id: "implement", kind: "quantum", dependsOn: [], status: "pending" }],
    })).toThrow(/step is invalid/i);
  });

  it("carries every step kind the core package declares in a snapshot", () => {
    // The snapshot schema is the other reader of a step, and it is the
    // one the renderer validates the payload it received with.
    for (const kind of WORKFLOW_STEP_KINDS) {
      const snapshot = parseSnapshot(snapshotWithStepKind(kind));
      expect(snapshot.workflowTemplates[0]?.steps[0]?.kind).toBe(kind);
    }
  });
});
