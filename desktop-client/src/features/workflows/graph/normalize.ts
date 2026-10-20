/**
 * The canvas's vocabulary for the workflow graph.
 *
 * The facts — which steps wait for which, what level a step runs at, whether
 * a template can be ordered at all — are computed once, by the shared step
 * graph. This module reports them in the studio's own words: the
 * `semantic/…` diagnostic codes, the track bands, the canvas positions.
 *
 * The desktop used to keep its own copy of the level formula, its own cycle
 * detection and its own topological order. That copy could disagree with the
 * one the template resolver runs on, which is how a canvas draws a level the
 * resolver would never run.
 */

import { computeStepGraph } from "@afk/workflow-graph/step-graph";
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
  /** The level each step runs at: 0 for a step with no dependencies, one more
   *  than its deepest dependency otherwise. */
  levels: ReadonlyMap<string, number>;
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

/**
 * The steps a step waits for: its declared dependencies plus the step its
 * `when` clause names. This is the edge set the template resolver feeds the
 * shared computation, so the canvas cannot draw a level the resolver would
 * not run.
 */
function stepEdges(step: WorkflowTemplateStepSummary): string[] {
  const edges = new Set(step.dependsOn);
  if (step.when) edges.add(step.when.step);
  return [...edges];
}

export function normalizeWorkflowSteps(input: readonly WorkflowTemplateStepSummary[]): NormalizedWorkflow {
  const steps = input.map((step) => ({ ...step, dependsOn: [...step.dependsOn] }));
  const graph = computeStepGraph(steps.map((step) => ({ id: step.id, dependsOn: stepEdges(step) })));

  const diagnostics: GraphDiagnostic[] = graph.missing.map((missing) => ({
    code: "semantic/missing-dependency",
    stepId: missing.stepId,
    dependencyId: missing.dependencyId,
    message: `${missing.stepId} depends on missing step ${missing.dependencyId}`,
  }));

  if (graph.cycle) {
    diagnostics.push({ code: "semantic/cycle", stepId: "", message: "workflow template contains a dependency cycle" });
    return { steps, order: [], levels: graph.levels, diagnostics };
  }
  return { steps, order: [...graph.order], levels: graph.levels, diagnostics };
}

export function workflowStepLayout(input: readonly WorkflowTemplateStepSummary[]): Map<string, WorkflowNodePosition> {
  const normalized = normalizeWorkflowSteps(input);
  if (normalized.diagnostics.some((diagnostic) => diagnostic.code === "semantic/cycle")) return new Map();
  // The level of a step is the shared computation's; where it sits on the
  // canvas is the studio's own arithmetic.
  const layers = new Map<number, WorkflowTemplateStepSummary[]>();
  normalized.steps.forEach((step) => {
    const layer = normalized.levels.get(step.id) ?? 0;
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
