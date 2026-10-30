/**
 * The cross-project backlog graph.
 *
 * A backlog relationship is an edge between two work item identities, not
 * between two issues of one repository. A PRD anchor may live in the
 * requirements repository while its implementation children live in the
 * service repository, so "does this item have children?" cannot be answered
 * by scanning the current project alone.
 *
 * Because relationship labels are canonical work item identities, the edges
 * join across repositories without any extra bookkeeping: the child names
 * its parent, and the parent is found by that identity.
 */

import type { BacklogItem } from './index.js';
import { parseWorkItemId } from '../work-item/identity.js';
import type { WorkItemId } from '../work-item/identity.js';

/** Read-only view over the backlog relationships of a set of items. */
export interface BacklogGraph {
  /** Every item in the graph. */
  items(): readonly BacklogItem[];
  /** The item with the given identity, if the graph holds it. */
  item(id: string): BacklogItem | undefined;
  /** Every item whose parent is the given identity, in any project. */
  childrenOf(id: string): BacklogItem[];
  /** Every item that has no parent. */
  roots(): BacklogItem[];
}

/**
 * A source of backlog relationships that spans every reachable project.
 *
 * The tracker adapter reads one project at a time, so it cannot answer
 * cross-project questions on its own. The credential-scoped inventory can.
 *
 * The port asks for the children of one item rather than for the whole
 * inventory, so an implementation can answer with a narrow, label-filtered
 * query instead of reading every issue of every project.
 */
export interface BacklogGraphSource {
  /** Every backlog item whose parent is the given identity. */
  childrenOf(id: string): Promise<BacklogItem[]>;
}

/**
 * The identity an item is filed under.
 *
 * Tracker-backed items already carry a canonical work item identity. Items
 * from providers that have no global identity keep their own id, so the graph
 * still works for a single project.
 */
function graphKey(id: string): string {
  try {
    return parseWorkItemId(id).id;
  } catch {
    return id;
  }
}

/** Build the graph over a flat, cross-project item list. */
export function buildBacklogGraph(items: readonly BacklogItem[]): BacklogGraph {
  const byKey = new Map<string, BacklogItem>();
  const children = new Map<string, BacklogItem[]>();
  for (const item of items) {
    byKey.set(graphKey(item.id), item);
  }
  for (const item of items) {
    if (!item.parentId) continue;
    const parentKey = graphKey(item.parentId);
    const siblings = children.get(parentKey);
    if (siblings) siblings.push(item);
    else children.set(parentKey, [item]);
  }
  return {
    items: () => items,
    item: id => byKey.get(graphKey(id)),
    childrenOf: id => children.get(graphKey(id)) ?? [],
    roots: () => items.filter(item => !item.parentId),
  };
}

/**
 * Find the dependency that would close a cycle.
 *
 * The new edge runs from the item to the work item it waits for. A cycle
 * exists when that dependency already reaches the item, so the walk follows
 * the dependency chain of every added dependency and reports the first item
 * that reaches the item being edited.
 *
 * A dependency that cannot be read is treated as a leaf: an unreadable item
 * hides its own chain, and the walk must not invent an edge it did not see.
 */
export async function findDependencyCycle(
  target: WorkItemId,
  dependencies: readonly WorkItemId[],
  read: (id: WorkItemId) => Promise<readonly WorkItemId[]>,
): Promise<WorkItemId | undefined> {
  const seen = new Set<string>();
  const pending = [...dependencies];
  while (pending.length) {
    const current = pending.pop();
    if (!current) break;
    if (current === target) return current;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of await read(current)) pending.push(next);
  }
  return undefined;
}
