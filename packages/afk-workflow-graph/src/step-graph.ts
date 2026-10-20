/**
 * The step graph — one computation of "what can run when".
 *
 * The level formula (a step runs one level after its deepest dependency) and
 * the cycle question were written out several times: in the template
 * resolver, in this package's layout, and again in the desktop's studio.
 * Each copy computed the same thing and reported it in its own vocabulary.
 *
 * This module computes the facts and lets each caller report them in the
 * words its own surface uses.
 */

export interface StepGraphInput {
  id: string;
  dependsOn: readonly string[];
}

export interface StepGraphMissingDependency {
  stepId: string;
  dependencyId: string;
}

export interface StepGraph {
  /** Level per step: 0 for a step with no dependencies, one more than its
   *  deepest dependency otherwise. Steps at the same level run together. */
  readonly levels: ReadonlyMap<string, number>;
  /** A deterministic topological order: source order first, then id. */
  readonly order: readonly string[];
  /** Dependencies that name a step the graph does not contain. */
  readonly missing: readonly StepGraphMissingDependency[];
  /** True when the dependencies cannot be ordered at all. */
  readonly cycle: boolean;
}

export function computeStepGraph(steps: readonly StepGraphInput[]): StepGraph {
  const ids = new Set(steps.map(step => step.id));
  const sourceOrder = new Map(steps.map((step, index) => [step.id, index]));
  const missing: StepGraphMissingDependency[] = [];
  const dependencies = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of steps) {
    const deps = step.dependsOn.filter(dependency => {
      if (ids.has(dependency)) return true;
      missing.push({ stepId: step.id, dependencyId: dependency });
      return false;
    });
    dependencies.set(step.id, deps);
    indegree.set(step.id, deps.length);
    for (const dependency of deps) {
      const children = dependents.get(dependency) ?? [];
      children.push(step.id);
      dependents.set(dependency, children);
    }
  }

  const compare = (left: string, right: string) =>
    (sourceOrder.get(left)! - sourceOrder.get(right)!) || left.localeCompare(right);
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort(compare);
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

  // A step the order did not reach is part of a cycle.
  const cycle = order.length !== steps.length;
  const levels = new Map<string, number>();
  if (!cycle) {
    // In topological order, so a parent is always levelled before its child.
    for (const id of order) {
      const parents = (dependencies.get(id) ?? []).map(parent => levels.get(parent) ?? 0);
      levels.set(id, parents.length ? Math.max(...parents) + 1 : 0);
    }
  }

  return { levels, order, missing, cycle };
}
