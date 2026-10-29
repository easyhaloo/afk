import type { GlobalWorkItem } from '../../domain/work-item/types.js';

/**
 * The children of one work item.
 *
 * A PRD anchor may live in the requirements repository while its
 * implementation children live in a service repository. The only thing that
 * joins them is the parent identity a child carries, so the question this
 * answers is a question about identities, not about one repository.
 */

/** The identity whose children are asked for. */
export interface WorkItemChildrenQuery {
  /** Canonical global identity: `platform:projectKey#issueNumber`. */
  parentId: string;
}

/** Where the answer came from. */
export type WorkItemChildrenSource = 'inventory' | 'refreshed';

export interface WorkItemChildrenResult {
  /** The item whose children were asked for. */
  parent: GlobalWorkItem;
  /** Its direct children, ordered by project and issue number. */
  children: GlobalWorkItem[];
  /** Whether the answer came from the local copy or from a refresh. */
  source: WorkItemChildrenSource;
}

/**
 * The local inventory a children query reads.
 *
 * The local copy is a cache, not the source of truth: a query that finds
 * nothing in it must be able to heal it, because the item may have been
 * created after the last collection.
 */
export interface WorkItemChildrenInventory {
  /**
   * The locally known item and its children, and whether that copy is still
   * current. The parent is part of the answer, so it belongs in the read.
   */
  read(parentId: string): Promise<{ items: readonly GlobalWorkItem[]; stale: boolean } | undefined>;
  /** Collect the items again from the providers. */
  refresh(parentId: string): Promise<{ items: readonly GlobalWorkItem[] } | undefined>;
}

/**
 * List the direct children of one work item.
 *
 * The local inventory answers first. A missing or stale copy is refreshed,
 * and an identity the local copy has never heard of is refreshed once more
 * before it is reported as unknown — the item may simply be newer than the
 * last collection.
 */
export async function listWorkItemChildren(
  inventory: WorkItemChildrenInventory,
  query: WorkItemChildrenQuery,
): Promise<WorkItemChildrenResult> {
  const local = await inventory.read(query.parentId);
  let items = local?.items ?? [];
  let refreshed = false;

  const refresh = async (): Promise<void> => {
    const collected = await inventory.refresh(query.parentId);
    if (!collected) return;
    items = collected.items;
    refreshed = true;
  };

  if (!local || local.stale) await refresh();

  let parent = findItem(items, query.parentId);
  if (!parent && !refreshed) {
    await refresh();
    parent = findItem(items, query.parentId);
  }
  if (!parent) throw new Error(`work item not found: ${query.parentId}`);

  const children = items
    .filter(item => item.parentId === query.parentId)
    .sort(compareByProjectAndNumber);

  return { parent, children, source: refreshed ? 'refreshed' : 'inventory' };
}

function findItem(items: readonly GlobalWorkItem[], id: string): GlobalWorkItem | undefined {
  return items.find(item => item.id === id);
}

/**
 * Siblings are read as a list, so their order must not depend on when the
 * inventory happened to be collected.
 */
function compareByProjectAndNumber(left: GlobalWorkItem, right: GlobalWorkItem): number {
  return left.project.projectKey.localeCompare(right.project.projectKey)
    || left.issueNumber - right.issueNumber;
}
