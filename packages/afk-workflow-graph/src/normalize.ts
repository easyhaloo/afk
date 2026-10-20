import { computeStepGraph } from './step-graph.js';
import type { GraphDiagnostic, GraphStep, WorkflowGraphDefinition } from './ir.js';

export interface NormalizationResult {
  readonly definition: WorkflowGraphDefinition;
  readonly steps: readonly GraphStep[];
  readonly order: readonly string[];
  readonly diagnostics: readonly GraphDiagnostic[];
}

export function normalizeDefinition(definition: WorkflowGraphDefinition): NormalizationResult {
  const diagnostics: GraphDiagnostic[] = [];
  const firstById = new Map<string, GraphStep>();
  const duplicateIds = new Set<string>();

  for (const step of definition.steps) {
    if (firstById.has(step.id)) {
      duplicateIds.add(step.id);
      diagnostics.push({ severity: 'error', code: 'duplicate-id', stepId: step.id, message: `Duplicate workflow step id: ${step.id}` });
    } else {
      firstById.set(step.id, step);
    }
  }

  const validSteps = definition.steps.filter((step) => !duplicateIds.has(step.id));
  const validIds = new Set(validSteps.map((step) => step.id));
  for (const step of validSteps) {
    if (step.when && !validIds.has(step.when.step)) {
      diagnostics.push({ severity: 'error', code: 'missing-condition-step', stepId: step.id, message: `Missing condition step: ${step.when.step}` });
    }
  }

  // The order, the levels and the cycle question come from one computation.
  const graph = computeStepGraph(validSteps.map((step) => ({ id: step.id, dependsOn: step.dependsOn })));
  for (const missing of graph.missing) {
    diagnostics.push({ severity: 'error', code: 'missing-dependency', stepId: missing.stepId, message: `Missing dependency: ${missing.dependencyId}` });
  }
  const order: string[] = [...graph.order];
  if (graph.cycle) {
    const cycleIds = validSteps.filter((step) => !order.includes(step.id)).map((step) => step.id);
    diagnostics.push({ severity: 'error', code: 'cycle', message: `Workflow contains a cycle: ${cycleIds.join(', ')}` });
  }

  if (!diagnostics.some((diagnostic) => diagnostic.code === 'cycle')) {
    // The cycle question over every step of the definition, including the
    // ones excluded from `validSteps` by a duplicate id. The computation is
    // the same one: a step id appears once here, with the union of the
    // dependencies its copies declare, so the shared step graph can order
    // them and answer the question.
    const rawDependencies = new Map<string, string[]>();
    for (const step of definition.steps) {
      rawDependencies.set(step.id, [...(rawDependencies.get(step.id) ?? []), ...step.dependsOn]);
    }
    const rawGraph = computeStepGraph(
      [...rawDependencies].map(([id, dependsOn]) => ({ id, dependsOn })),
    );
    if (rawGraph.cycle) {
      diagnostics.push({ severity: 'error', code: 'cycle', message: 'Workflow contains a cycle' });
    }
  }

  const orderedSteps = order.map((id) => firstById.get(id)!).filter(Boolean);
  return {
    definition: { ...definition, steps: orderedSteps },
    steps: orderedSteps,
    order,
    diagnostics,
  };
}
