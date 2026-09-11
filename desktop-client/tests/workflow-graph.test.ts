import { describe, expect, it } from "vitest";
import { normalizeWorkflowSteps, workflowStepLayout } from "../src/features/workflows/graph/normalize";
import type { WorkflowTemplateStepSummary } from "../shared/ipc-contract";

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
});
