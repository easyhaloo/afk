import { describe, expect, it } from "vitest";
import { normalizeWorkflowSteps, workflowConditionLabelWidth, workflowStepLayout } from "../src/features/workflows/graph/normalize.js";
import type { WorkflowTemplateStepSummary } from "../shared/ipc-contract.js";

const step = (id: string, dependsOn: string[] = []): WorkflowTemplateStepSummary => ({
  id,
  role: "agent",
  kind: "agent",
  dependsOn,
});

describe("workflow graph normalization", () => {
  it("reports missing dependencies without emitting an undefined node", () => {
    const result = normalizeWorkflowSteps([step("review", ["implement"]) ]);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "semantic/missing-dependency", stepId: "review", dependencyId: "implement" }),
    ]);
    expect(result.steps.map((item) => item.id)).toEqual(["review"]);
  });

  it("reports cycles instead of assigning an arbitrary depth", () => {
    const result = normalizeWorkflowSteps([step("a", ["b"]), step("b", ["a"]) ]);

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "semantic/cycle" }),
    ]);
    expect(result.order).toEqual([]);
  });

  it("produces deterministic layered positions for valid steps", () => {
    const steps = [step("implement"), step("review", ["implement"]), step("publish", ["review"])];

    const first = workflowStepLayout(steps);
    const second = workflowStepLayout([...steps]);

    expect([...first.entries()]).toEqual([...second.entries()]);
    expect(first.get("implement")?.x).toBeLessThan(first.get("review")?.x ?? 0);
    expect(first.get("review")?.x).toBeLessThan(first.get("publish")?.x ?? 0);
  });

  it("keeps a sequential workflow on one row across agent and system steps", () => {
    const system: WorkflowTemplateStepSummary = { ...step("commit", ["implement"]), kind: "system" };
    const layout = workflowStepLayout([step("implement"), system]);

    const agent = layout.get("implement");
    const sys = layout.get("commit");
    expect(agent).toBeDefined();
    expect(sys).toBeDefined();
    expect(sys?.y).toBe(agent?.y);
  });

  it("stacks same-depth steps of one track without overlapping each other", () => {
    const layout = workflowStepLayout([step("implement"), step("review")]);

    const first = layout.get("implement");
    const second = layout.get("review");
    expect(first!.x).toBe(second!.x);
    expect(second!.y - first!.y).toBeGreaterThanOrEqual(94);
  });

  it("centers a fork and its join around parallel steps of different kinds", () => {
    const layout = workflowStepLayout([
      step("implement"),
      step("verify", ["implement"]),
      { ...step("review", ["implement"]), kind: "system" },
      { ...step("publish", ["verify", "review"]), kind: "system" },
    ]);
    expect(layout.get("verify")?.x).toBe(layout.get("review")?.x);
    expect(layout.get("review")!.y - layout.get("verify")!.y).toBeGreaterThanOrEqual(184);
    expect(layout.get("implement")?.y).toBe(layout.get("publish")?.y);
    expect(layout.get("publish")?.y).toBe((layout.get("verify")!.y + layout.get("review")!.y) / 2);
  });

  it("reserves enough space for conditional edge labels between columns", () => {
    const when = { step: "acceptance-review", equals: "PASS" };
    const layout = workflowStepLayout([step("acceptance-review"), { ...step("publish", ["acceptance-review"]), when }]);
    expect(workflowConditionLabelWidth(undefined)).toBe(0);
    expect(workflowConditionLabelWidth(when)).toBeGreaterThanOrEqual("acceptance-review = PASS".length * 6);
    expect(layout.get("publish")!.x - layout.get("acceptance-review")!.x).toBeGreaterThanOrEqual(200 + workflowConditionLabelWidth(when) + 40);
  });
});
