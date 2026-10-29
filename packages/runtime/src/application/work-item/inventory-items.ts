import type { InventoryItem } from '@afk/application';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';
import { parseWorkItemId, type WorkItemId } from '../../domain/work-item/identity.js';

/**
 * The mirror and the work item model describe the same record.
 *
 * The inventory stores what the providers reported, in the shape the local
 * query speaks; the runtime works with the work item. Reading one back as
 * the other keeps a single answer for "what is this issue" instead of two
 * shapes that drift apart.
 */

/**
 * The canonical identity a stored relation names.
 *
 * A stored relation that is not canonical names nothing this runtime can
 * match, so it is dropped rather than carried as a malformed identity.
 */
function toWorkItemId(value: string): WorkItemId | undefined {
  try {
    return parseWorkItemId(value).id;
  } catch {
    return undefined;
  }
}

/** Read one stored inventory item back as the work item it mirrors. */
export function toGlobalWorkItemFromInventory(item: InventoryItem): GlobalWorkItem {
  // The mirror only accepts an item whose identity matches its project, so a
  // stored id is canonical. A relation is best effort: one that is not
  // canonical names nothing this runtime can match.
  const id = parseWorkItemId(item.id).id;
  const parentId = item.parentId === undefined ? undefined : toWorkItemId(item.parentId);
  return {
    id,
    issueNumber: item.issueNumber,
    project: item.project,
    title: item.title,
    ...(item.description === undefined ? {} : { description: item.description }),
    managed: item.managed,
    executionEligible: item.executionEligible,
    state: item.state,
    executionMode: item.executionMode,
    ...(parentId === undefined ? {} : { parentId }),
    dependsOn: item.dependsOn.map(toWorkItemId).filter((value): value is WorkItemId => value !== undefined),
    tags: [...item.tags],
    branchName: item.branchName,
    providerRef: item.providerRef,
    ...(item.webUrl === undefined ? {} : { webUrl: item.webUrl }),
    ...(item.updatedAt === undefined ? {} : { updatedAt: item.updatedAt }),
  };
}

/** Read a page of stored inventory items back as work items. */
export function toGlobalWorkItems(items: readonly InventoryItem[]): GlobalWorkItem[] {
  return items.map(toGlobalWorkItemFromInventory);
}
