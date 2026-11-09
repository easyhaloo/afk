/**
 * The range a schedule decision depends on.
 *
 * A scheduler reads the whole platform: the credentials reach every project
 * AFK may look at, and a PRD's slices live in the repositories the work
 * touches. Those are two different ranges, and the old scheduler treated them
 * as one — so a project nobody in the PRD cares about could not be read, and
 * the whole PRD went blind.
 *
 * This module owns the first range: which projects and which work items the
 * decision depends on. The inventory owns the second one: what the provider
 * actually reported.
 *
 * The scope is computed from the relationships AFK itself writes. A child
 * names its parent, and a dependency names the item it waits for, so the
 * edges join across repositories. An edge also names a project even when
 * that project could not be read — a canonical work item identity carries its
 * project key — which is what makes an unreadable dependency a fact about the
 * scope rather than a silent gap in it.
 */

import { parseWorkItemId } from '../work-item/identity.js';
import type { GlobalWorkItem } from '../work-item/types.js';
import type { InventoryDiagnostic } from '../work-item/provider-types.js';

/** The range a schedule decision depends on. */
export interface ScheduleScope {
  /** The parent PRD the scope was computed for. */
  parentId: string;
  /** Every canonical project key the decision depends on. */
  projects: ReadonlySet<string>;
  /** Every work item identity the decision depends on. */
  items: ReadonlySet<string>;
}

/** How the scope's own visibility fails. */
export interface ScheduleScopeAssessment {
  /**
   * Diagnostics inside the scope.
   *
   * These are fatal for the work that depends on them: AFK does not know
   * what it is deciding about.
   */
  blocking: InventoryDiagnostic[];
  /**
   * Diagnostics outside the scope.
   *
   * They are named and reported, and they never stop the schedule: a project
   * nobody in the PRD touches says nothing about the PRD.
   */
  reported: InventoryDiagnostic[];
}

/**
 * The canonical project key a work item identity names.
 *
 * `undefined` when the identity is not a canonical one — the scope then
 * cannot say which project it belongs to, and says so instead of guessing.
 */
export function workItemProjectKey(id: string): string | undefined {
  try {
    return parseWorkItemId(id).projectKey;
  } catch {
    return undefined;
  }
}

/**
 * Compute the range a schedule decision depends on.
 *
 * The scope is the parent PRD, its children (transitively), and everything
 * those wait for (transitively). The dependency closure is part of the scope
 * because a slice's runnability is decided by the state of what it waits for,
 * and that state lives in another repository.
 *
 * A dependency whose item could not be read still contributes its project:
 * the identity names the project, so the scope knows that project matters
 * even when the provider reported nothing about it.
 */
export function computeScheduleScope(items: readonly GlobalWorkItem[], parentId: string): ScheduleScope {
  const byId = new Map<string, GlobalWorkItem>(items.map(item => [item.id, item]));
  const children = new Map<string, string[]>();
  for (const item of items) {
    if (!item.parentId) continue;
    const siblings = children.get(item.parentId);
    if (siblings) siblings.push(item.id);
    else children.set(item.parentId, [item.id]);
  }

  const projects = new Set<string>();
  const scopeItems = new Set<string>();
  const pending = [parentId];
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined || scopeItems.has(current)) continue;
    scopeItems.add(current);
    const item = byId.get(current);
    const projectKey = item?.project.projectKey ?? workItemProjectKey(current);
    if (projectKey) projects.add(projectKey);
    for (const child of children.get(current) ?? []) pending.push(child);
    for (const dependency of item?.dependsOn ?? []) pending.push(dependency);
  }
  return { parentId, projects, items: scopeItems };
}

/**
 * Split the diagnostics into the ones the scope depends on and the ones it
 * does not.
 *
 * A diagnostic about a project inside the scope is fatal for the work that
 * depends on that project: AFK does not know what it is deciding about. A
 * diagnostic about any other project is reported and nothing more — the
 * schedule is about the scope, not about the platform.
 *
 * A project list failure is always inside the scope. AFK could not enumerate
 * the candidate projects, so it cannot know which of them the PRD reaches,
 * and a project it never saw cannot be excluded from the scope either.
 */
export function assessScheduleScope(
  scope: ScheduleScope,
  diagnostics: readonly InventoryDiagnostic[],
): ScheduleScopeAssessment {
  const blocking: InventoryDiagnostic[] = [];
  const reported: InventoryDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    const inside = diagnostic.code === 'project_list_failed' || scope.projects.has(diagnostic.projectKey);
    (inside ? blocking : reported).push(diagnostic);
  }
  return { blocking, reported };
}
