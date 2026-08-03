/**
 * Dependency resolver — given a WorkflowTemplate, produces an execution plan:
 * an ordered list of `groups`, where each group runs concurrently and groups
 * run sequentially.
 *
 * Algorithm:
 *   1. Validate references (every dependsOn / when.step / parallel step id
 *      exists in the template).
 *   2. Compute levels via Kahn's algorithm (BFS topological sort). Each step
 *      is assigned the level = 1 + max(level(deps)).
 *   3. Group steps by level. Steps at the same level run concurrently.
 *   4. Within a level, preserve declaration order for deterministic scheduling.
 *
 * Cycles raise TemplateError.
 */

import type { WorkflowTemplate, Step } from './types';
import { TemplateError } from './types';

export interface ExecutionGroup {
  level: number;
  /** Steps in this group, in declaration order. */
  steps: Step[];
}

export interface ExecutionPlan {
  templateName: string;
  groups: ExecutionGroup[];
}

/**
 * Resolve the template into an execution plan.
 *
 * The `allStepIds` parameter is the union of step IDs in the template PLUS
 * step IDs the template references in its when/dependsOn clauses. Defaults
 * to the template's step IDs; pass an expanded set if the runner knows about
 * additional steps it plans to inject.
 */
export function resolveExecutionPlan(template: WorkflowTemplate, allStepIds?: Set<string>): ExecutionPlan {
  const validIds = allStepIds ?? new Set(template.steps.map(s => s.id));
  for (const step of template.steps) {
    if (!validIds.has(step.id)) {
      throw new TemplateError(`step id '${step.id}' not in valid set`, template.name);
    }
    for (const dep of step.dependsOn ?? []) {
      if (!validIds.has(dep)) {
        throw new TemplateError(`step '${step.id}' depends on unknown step '${dep}'`, template.name);
      }
    }
    if (step.when && !validIds.has(step.when.step)) {
      throw new TemplateError(`step '${step.id}' when-clause references unknown step '${step.when.step}'`, template.name);
    }
  }

  // Self-dependency check (cheap pre-check before Kahn's).
  for (const step of template.steps) {
    if ((step.dependsOn ?? []).includes(step.id)) {
      throw new TemplateError(`step '${step.id}' depends on itself`, template.name);
    }
  }

  // Compute in-degree for Kahn's algorithm.
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep -> [steps that depend on it]
  for (const step of template.steps) {
    const deps = step.dependsOn ?? [];
    inDegree.set(step.id, deps.length);
    if (!dependents.has(step.id)) dependents.set(step.id, []);
    for (const dep of deps) {
      if (!dependents.has(dep)) dependents.set(dep, []);
      dependents.get(dep)!.push(step.id);
    }
  }

  // BFS levels.
  const levelByStep = new Map<string, number>();
  const queue: string[] = template.steps.filter(s => (s.dependsOn ?? []).length === 0).map(s => s.id);
  for (const id of queue) levelByStep.set(id, 0);

  let processed = 0;
  while (queue.length > 0) {
    const id = queue.shift()!;
    processed++;
    const myLevel = levelByStep.get(id) ?? 0;
    for (const dep of dependents.get(id) ?? []) {
      const next = Math.max(levelByStep.get(dep) ?? 0, myLevel + 1);
      levelByStep.set(dep, next);
      const remaining = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, remaining);
      if (remaining === 0) queue.push(dep);
    }
  }

  if (processed !== template.steps.length) {
    throw new TemplateError(`dependency cycle detected`, template.name);
  }

  // Group by level.
  const maxLevel = Math.max(0, ...levelByStep.values());
  const groups: ExecutionGroup[] = [];
  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const steps = template.steps
      .filter(s => levelByStep.get(s.id) === lvl)
      // Preserve declaration order.
      .sort((a, b) => template.steps.indexOf(a) - template.steps.indexOf(b));
    groups.push({ level: lvl, steps });
  }

  return { templateName: template.name, groups };
}

/** Quick check for cyclic dependencies without computing the full plan. */
export function hasCycle(template: WorkflowTemplate): boolean {
  try {
    resolveExecutionPlan(template);
    return false;
  } catch (err) {
    if (err instanceof TemplateError && /cycle/i.test(err.message)) return true;
    throw err;
  }
}