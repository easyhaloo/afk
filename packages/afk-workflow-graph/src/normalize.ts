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
  const dependencies = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of validSteps) {
    const deps = step.dependsOn.filter((dependency) => {
      if (!validIds.has(dependency)) {
        diagnostics.push({ severity: 'error', code: 'missing-dependency', stepId: step.id, message: `Missing dependency: ${dependency}` });
        return false;
      }
      return true;
    });
    if (step.when && !validIds.has(step.when.step)) {
      diagnostics.push({ severity: 'error', code: 'missing-condition-step', stepId: step.id, message: `Missing condition step: ${step.when.step}` });
    }
    dependencies.set(step.id, deps);
    indegree.set(step.id, deps.length);
    for (const dependency of deps) {
      const children = dependents.get(dependency) ?? [];
      children.push(step.id);
      dependents.set(dependency, children);
    }
  }

  const sourceOrder = new Map(validSteps.map((step, index) => [step.id, index]));
  const ready = validSteps.filter((step) => indegree.get(step.id) === 0).map((step) => step.id);
  const compare = (a: string, b: string) => (sourceOrder.get(a)! - sourceOrder.get(b)!) || a.localeCompare(b);
  ready.sort(compare);
  const order: string[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const child of dependents.get(id) ?? []) {
      const next = indegree.get(child)! - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort(compare);
      }
    }
  }

  if (order.length !== validSteps.length) {
    const cycleIds = validSteps.filter((step) => !order.includes(step.id)).map((step) => step.id);
    diagnostics.push({ severity: 'error', code: 'cycle', message: `Workflow contains a cycle: ${cycleIds.join(', ')}` });
  }

  if (!diagnostics.some((diagnostic) => diagnostic.code === 'cycle')) {
    const rawIds = new Set(definition.steps.map((step) => step.id));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasRawCycle = (id: string): boolean => {
      if (visiting.has(id)) return true;
      if (visited.has(id)) return false;
      visiting.add(id);
      for (const step of definition.steps.filter((candidate) => candidate.id === id)) {
        if (step.dependsOn.some((dependency) => rawIds.has(dependency) && hasRawCycle(dependency))) return true;
      }
      visiting.delete(id);
      visited.add(id);
      return false;
    };
    if (definition.steps.some((step) => hasRawCycle(step.id))) {
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
