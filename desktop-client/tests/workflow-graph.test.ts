import { describe, expect, it } from "vitest";
import { resolveExecutionPlan } from "@afk/execution/domain/templates/resolver";
import { BUILTIN_WORKFLOW_TEMPLATES } from "../electron/services/desktop-service.js";
import { builtinTemplates } from "@afk/execution/domain/templates/builtin";
import { normalizeWorkflowSteps, workflowStepLayout, type WorkflowNodePosition } from "../src/features/workflows/graph/normalize";
import type { WorkflowTemplateStepSummary } from "../shared/ipc-contract";

const step = (id: string, dependsOn: string[] = []): WorkflowTemplateStepSummary => ({
  id,
  role: "agent",
  kind: "agent",
  dependsOn,
});

const conditional = (id: string, when: string, dependsOn: string[] = []): WorkflowTemplateStepSummary => ({
  ...step(id, dependsOn),
  when: { step: when, equals: "failed" },
});

/** The results a `when` clause may name; the resolver's vocabulary. */
const RESULTS = ["completed", "failed", "aborted", "timed_out"] as const;
const isResult = (value: string | undefined): value is (typeof RESULTS)[number] =>
  value !== undefined && (RESULTS as readonly string[]).includes(value);

/** The plan the template resolver runs for the same steps. */
const resolverPlan = (steps: readonly WorkflowTemplateStepSummary[]) =>
  resolveExecutionPlan({
    name: "canvas-agreement",
    version: 1,
    steps: steps.map((step) => ({
      id: step.id,
      role: step.role,
      kind: step.kind,
      dependsOn: [...step.dependsOn],
      ...(step.when
        ? {
            when: {
              step: step.when.step,
              ...(isResult(step.when.equals) ? { equals: step.when.equals } : {}),
              ...(isResult(step.when.notEquals) ? { notEquals: step.when.notEquals } : {}),
            },
          }
        : {}),
    })),
  });

/** The level the canvas drew each step at, read back off the positions. */
const canvasLevels = (layout: Map<string, WorkflowNodePosition>): Map<string, number> => {
  const columns = [...new Set([...layout.values()].map((position) => position.x))].sort((left, right) => left - right);
  return new Map([...layout].map(([id, position]) => [id, columns.indexOf(position.x)]));
};

/** The level the resolver runs each step at. */
const resolverLevels = (steps: readonly WorkflowTemplateStepSummary[]): Map<string, number> => {
  const plan = resolverPlan(steps);
  return new Map(plan.groups.flatMap((group) => group.steps.map((step) => [step.id, group.level] as const)));
};

describe("workflow graph normalization", () => {
  it("reports missing dependencies without emitting an undefined node", () => {
    const result = normalizeWorkflowSteps([step("review", ["implement"])]);

    expect(result.diagnostics).toEqual([
      {
        code: "semantic/missing-dependency",
        stepId: "review",
        dependencyId: "implement",
        message: "review depends on missing step implement",
      },
    ]);
    expect(result.steps.map((item) => item.id)).toEqual(["review"]);
  });

  it("reports cycles instead of assigning an arbitrary depth", () => {
    const result = normalizeWorkflowSteps([step("a", ["b"]), step("b", ["a"])]);

    expect(result.diagnostics).toEqual([
      { code: "semantic/cycle", stepId: "", message: "workflow template contains a dependency cycle" },
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

  it("gives each track its own row so lane bands cannot overlap", () => {
    const system: WorkflowTemplateStepSummary = { ...step("commit", ["implement"]), kind: "system" };
    const layout = workflowStepLayout([step("implement"), system]);

    const agent = layout.get("implement");
    const sys = layout.get("commit");
    expect(agent).toBeDefined();
    expect(sys).toBeDefined();
    // One row apart: node height 94 + 28px band padding above and below.
    expect((sys?.y ?? 0) - (agent?.y ?? 0)).toBeGreaterThanOrEqual(94 + 56);
  });

  it("stacks same-depth steps of one track without overlapping each other", () => {
    const layout = workflowStepLayout([step("implement"), step("review")]);

    const first = layout.get("implement");
    const second = layout.get("review");
    expect(first!.x).toBe(second!.x);
    expect(second!.y - first!.y).toBeGreaterThanOrEqual(94);
  });
});

describe("the canvas and the resolver agree", () => {
  it("draws the level the resolver runs, not the level dependsOn alone implies", () => {
    // `fix` waits for `review` through its when clause only. The resolver
    // orders it after `review`; a canvas that read only dependsOn would draw
    // it in the first column, a level the resolver never runs it at.
    const steps = [step("implement"), step("review", ["implement"]), conditional("fix", "review")];

    const layout = workflowStepLayout(steps);

    expect(canvasLevels(layout)).toEqual(resolverLevels(steps));
    expect(canvasLevels(layout).get("fix")).toBe(2);
    expect(layout.get("fix")?.x).toBe(600);
  });

  it("agrees about the levels of a plain dependency chain", () => {
    const steps = [step("implement"), step("review", ["implement"]), step("publish", ["review"])];

    expect(canvasLevels(workflowStepLayout(steps))).toEqual(resolverLevels(steps));
  });

  it("agrees that a cyclic template cannot be ordered", () => {
    const steps = [step("a", ["b"]), step("b", ["a"])];

    expect(normalizeWorkflowSteps(steps).diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["semantic/cycle"]);
    expect(workflowStepLayout(steps).size).toBe(0);
    expect(() => resolverPlan(steps)).toThrow(/cycle/i);
  });

  it("agrees that a when clause naming an absent step breaks the template", () => {
    const steps = [step("implement"), conditional("fix", "missing")];

    expect(normalizeWorkflowSteps(steps).diagnostics).toEqual([
      {
        code: "semantic/missing-dependency",
        stepId: "fix",
        dependencyId: "missing",
        message: "fix depends on missing step missing",
      },
    ]);
    expect(() => resolverPlan(steps)).toThrow(/unknown step 'missing'/);
  });
});

describe("the built-in templates are the ones the runner runs", () => {
  it("shows every built-in template with the conditions the runner applies", () => {
    for (const template of builtinTemplates()) {
      const shown = BUILTIN_WORKFLOW_TEMPLATES.find((item) => item.id === template.name);
      expect(shown?.steps.map((step) => step.id)).toEqual(template.steps.map((step) => step.id));
      expect(shown?.steps.map((step) => step.when)).toEqual(template.steps.map((step) => step.when));
    }
  });
});

describe("the built-in templates keep their canvas positions", () => {
  it("draws every built-in template where it was drawn before", () => {
    const positions = Object.fromEntries(
      BUILTIN_WORKFLOW_TEMPLATES.map((template) => [template.id, Object.fromEntries(workflowStepLayout(template.steps))]),
    );

    expect(positions).toEqual({
      "issue-implementation": {
        implement: { x: 220, y: 54 },
        "verify-ac": { x: 410, y: 54 },
        // `publish` runs only when the verification completed, so it is drawn
        // on the conditional track. It used to be drawn on the workflow
        // track, because the desktop's copy of the template had lost the
        // condition.
        publish: { x: 600, y: 414 },
        "queue-qa": { x: 790, y: 234 },
      },
      "pre-merge-qa-verification": {
        "verify-ac": { x: 220, y: 54 },
      },
      "simple-loop": {
        run: { x: 220, y: 54 },
      },
      "sequential-review": {
        implement: { x: 220, y: 54 },
        review: { x: 410, y: 54 },
        fix: { x: 600, y: 414 },
      },
      "parallel-planner": {
        "plan-frontend": { x: 220, y: 54 },
        "plan-backend": { x: 220, y: 178 },
        "plan-infra": { x: 220, y: 302 },
      },
      "planner-with-review": {
        "plan-frontend": { x: 220, y: 54 },
        "plan-backend": { x: 220, y: 178 },
        review: { x: 410, y: 54 },
        // The same: `fix` runs only when the review failed.
        fix: { x: 600, y: 414 },
      },
    });
  });
});
