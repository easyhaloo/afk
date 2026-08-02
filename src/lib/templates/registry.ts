/**
 * TemplateRegistry — in-memory registry of WorkflowTemplates.
 * Builtins are registered on first access; tests can register additional
 * templates or replace the builtins via _resetTemplateRegistry().
 */

import type { WorkflowTemplate } from './types';
import { builtinTemplates } from './builtin';
import { resolveExecutionPlan } from './resolver';

const registry = new Map<string, WorkflowTemplate>();

function ensureBuiltins(): void {
  if (registry.size === 0) {
    for (const t of builtinTemplates()) registry.set(t.name, t);
  }
}

/** Register a template by name. Overwrites existing. */
export function registerTemplate(template: WorkflowTemplate): void {
  registry.set(template.name, template);
}

/** Look up by name. Returns undefined when missing. */
export function getTemplate(name: string): WorkflowTemplate | undefined {
  ensureBuiltins();
  return registry.get(name);
}

/** Same as getTemplate but throws. */
export function requireTemplate(name: string): WorkflowTemplate {
  const t = getTemplate(name);
  if (!t) throw new Error(`template not registered: ${name}`);
  return t;
}

/** List registered template names. */
export function listTemplates(): string[] {
  ensureBuiltins();
  return [...registry.keys()];
}

/**
 * Resolve a template to an execution plan. Throws if the template has
 * dependency cycles or references unknown steps.
 */
export function planFor(name: string) {
  return resolveExecutionPlan(requireTemplate(name));
}

/** Reset the registry — used by tests to isolate state. Re-registers builtins. */
export function _resetTemplateRegistry(): void {
  registry.clear();
  for (const t of builtinTemplates()) registry.set(t.name, t);
}