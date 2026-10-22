import type { WorkflowTemplateStepSummary } from "../../../../shared/ipc-contract.js";
import { CANVAS_NODE_WIDTH } from "./canvas-layout.js";

export type GraphDiagnostic = {
  code: "semantic/missing-dependency" | "semantic/cycle";
  stepId: string;
  dependencyId?: string;
  message: string;
};

export type NormalizedWorkflow = {
  steps: WorkflowTemplateStepSummary[];
  order: string[];
  diagnostics: GraphDiagnostic[];
};

export type WorkflowNodePosition = { x: number; y: number };

export type WorkflowCanvasTrack = "agent" | "system" | "conditional";

const LAYER_GAP = 244;
const ROW_GAP = 184;

export function workflowStepTrack(step?: WorkflowTemplateStepSummary): WorkflowCanvasTrack {
  return step?.when ? "conditional" : step?.kind === "system" ? "system" : "agent";
}

export function workflowConditionLabelWidth(when: WorkflowTemplateStepSummary["when"]): number {
  return when ? Math.max(72, `${when.step} = ${when.equals}`.length * 7 + 14) : 0;
}

export function normalizeWorkflowSteps(input: readonly WorkflowTemplateStepSummary[]): NormalizedWorkflow {
  const steps = input.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  const byId = new Map(steps.map((step) => [step.id, step]));
  const diagnostics: GraphDiagnostic[] = [];

  for (const step of steps) {
    for (const dependencyId of step.dependsOn) {
      if (!byId.has(dependencyId)) {
        diagnostics.push({
          code: "semantic/missing-dependency",
          stepId: step.id,
          dependencyId,
          message: `${step.id} depends on missing step ${dependencyId}`,
        });
      }
    }
  }

  const order: string[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let hasCycle = false;
  const visit = (step: WorkflowTemplateStepSummary) => {
    if (visited.has(step.id)) return;
    if (visiting.has(step.id)) {
      hasCycle = true;
      return;
    }
    visiting.add(step.id);
    for (const dependencyId of step.dependsOn) {
      const dependency = byId.get(dependencyId);
      if (dependency) visit(dependency);
    }
    visiting.delete(step.id);
    visited.add(step.id);
    order.push(step.id);
  };
  steps.forEach(visit);
  if (hasCycle) {
    diagnostics.push({ code: "semantic/cycle", stepId: "", message: "workflow template contains a dependency cycle" });
    return { steps, order: [], diagnostics };
  }
  return { steps, order, diagnostics };
}

export function workflowStepLayout(input: readonly WorkflowTemplateStepSummary[]): Map<string, WorkflowNodePosition> {
  const normalized = normalizeWorkflowSteps(input);
  if (normalized.diagnostics.some((diagnostic) => diagnostic.code === "semantic/cycle")) return new Map();
  const byId = new Map(normalized.steps.map((step) => [step.id, step]));
  const depth = new Map<string, number>();
  const depthOf = (step: WorkflowTemplateStepSummary): number => {
    const cached = depth.get(step.id);
    if (cached !== undefined) return cached;
    const parents = step.dependsOn.map((id) => byId.get(id)).filter((item): item is WorkflowTemplateStepSummary => Boolean(item));
    const value = parents.length ? Math.max(...parents.map(depthOf)) + 1 : 0;
    depth.set(step.id, value);
    return value;
  };
  const layers = new Map<number, WorkflowTemplateStepSummary[]>();
  normalized.steps.forEach((step) => {
    const layer = depthOf(step);
    layers.set(layer, [...(layers.get(layer) ?? []), step]);
  });
  const positions = new Map<string, WorkflowNodePosition>();
  const maxRows = Math.max(1, ...[...layers.values()].map((steps) => steps.length));
  let columnX = 292 - LAYER_GAP;
  [...layers.entries()].sort(([left], [right]) => left - right).forEach(([, steps]) => {
    const labelWidth = Math.max(0, ...steps.map(step => workflowConditionLabelWidth(step.when)));
    columnX += Math.max(LAYER_GAP, CANVAS_NODE_WIDTH + labelWidth + 40);
    const tracks: WorkflowCanvasTrack[] = ["agent", "system", "conditional"];
    steps.sort((left, right) => tracks.indexOf(workflowStepTrack(left)) - tracks.indexOf(workflowStepTrack(right)));
    steps.forEach((step, row) => {
      positions.set(step.id, { x: columnX, y: 94 + ((maxRows - steps.length) / 2 + row) * ROW_GAP });
    });
  });
  return positions;
}
