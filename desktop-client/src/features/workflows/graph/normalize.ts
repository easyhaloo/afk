import type { WorkflowTemplateStepSummary } from "../../../../shared/ipc-contract";

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

/** Each track owns a canvas row, so its lane band never overlaps another track's. */
const TRACKS: readonly WorkflowCanvasTrack[] = ["agent", "system", "conditional"];

const LAYER_GAP = 190;
const ROW_GAP = 124;
/** Track pitch: a within-track row gap plus the 28px band padding above and below,
 *  so one band's box can never reach the next track's. */
const TRACK_GAP = 180;

export function workflowStepTrack(step?: WorkflowTemplateStepSummary): WorkflowCanvasTrack {
  return step?.when ? "conditional" : step?.kind === "system" ? "system" : "agent";
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
  [...layers.entries()].sort(([left], [right]) => left - right).forEach(([layer, steps]) => {
    const rowsInTrack = new Map<WorkflowCanvasTrack, number>();
    steps.forEach((step) => {
      const track = workflowStepTrack(step);
      const row = rowsInTrack.get(track) ?? 0;
      rowsInTrack.set(track, row + 1);
      positions.set(step.id, { x: 220 + layer * LAYER_GAP, y: 54 + TRACKS.indexOf(track) * TRACK_GAP + row * ROW_GAP });
    });
  });
  return positions;
}
