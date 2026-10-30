/**
 * The fields a children query needs from an item.
 *
 * The query answers a question about identities, so it only needs the
 * identity, the number and the project of an item. Every surface that asks
 * keeps its own richer item shape and hands it over unchanged.
 */
export interface WorkItemChildrenEntry {
  id: string;
  issueNumber: number;
  project: { projectKey: string };
  parentId?: string;
}

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

export interface WorkItemChildrenResult<Item extends WorkItemChildrenEntry> {
  /** The item whose children were asked for. */
  parent: Item;
  /** Its direct children, ordered by project and issue number. */
  children: Item[];
  /**
   * Every item the answer was derived from.
   *
   * A dependency may live outside the subtree, so the items the answer
   * rests on are part of the answer: a caller that wants to explain why a
   * child is waiting needs the whole set, not only the children.
   */
  items: readonly Item[];
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
export interface WorkItemChildrenInventory<Item extends WorkItemChildrenEntry> {
  /**
   * The locally known item and its children, and whether that copy is still
   * current. The parent is part of the answer, so it belongs in the read.
   */
  read(parentId: string): Promise<{ items: readonly Item[]; stale: boolean } | undefined>;
  /** Collect the items again from the providers. */
  refresh(parentId: string): Promise<{ items: readonly Item[] } | undefined>;
}

/**
 * A stored inventory, and the collection that heals it.
 *
 * The two surfaces that answer this question — the command line and the
 * desktop client — keep their copy in different places, but they agree on
 * what a copy is: the items of the last collection and the time it
 * succeeded.
 */
export interface WorkItemChildrenStore<Item extends WorkItemChildrenEntry> {
  /** The parent and its children as they are stored locally. */
  read(parentId: string): Promise<{ items: readonly Item[]; lastSuccessAt?: number } | undefined>;
  /** Collect the items again from the providers. */
  collect(): Promise<{ items: readonly Item[] } | undefined>;
}

/** How long a stored copy is trusted before it is collected again. */
export const DEFAULT_CHILDREN_STALE_AFTER_MS = 5 * 60_000;

/**
 * The children query over a stored inventory.
 *
 * The stored copy answers until it goes stale. A copy that has never
 * succeeded has no time to compare against, so it is stale too: the first
 * query after a fresh install pays for the collection.
 */
export function createMirrorWorkItemChildrenInventory<Item extends WorkItemChildrenEntry>(
  store: WorkItemChildrenStore<Item>,
  options: { staleAfterMs?: number } = {},
): WorkItemChildrenInventory<Item> {
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_CHILDREN_STALE_AFTER_MS;
  return {
    async read(parentId) {
      const stored = await store.read(parentId);
      if (!stored) return undefined;
      const lastSuccessAt = stored.lastSuccessAt;
      const stale = lastSuccessAt === undefined || Date.now() - lastSuccessAt >= staleAfterMs;
      return { items: stored.items, stale };
    },
    async refresh(parentId) {
      const collected = await store.collect();
      if (!collected) return undefined;
      return { items: collected.items };
    },
  };
}

/**
 * List the direct children of one work item.
 *
 * The local inventory answers first. A missing or stale copy is refreshed,
 * and an identity the local copy has never heard of is refreshed once more
 * before it is reported as unknown — the item may simply be newer than the
 * last collection.
 */
export async function listWorkItemChildren<Item extends WorkItemChildrenEntry>(
  inventory: WorkItemChildrenInventory<Item>,
  query: WorkItemChildrenQuery,
): Promise<WorkItemChildrenResult<Item>> {
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

  return { parent, children, items, source: refreshed ? 'refreshed' : 'inventory' };
}

function findItem<Item extends WorkItemChildrenEntry>(items: readonly Item[], id: string): Item | undefined {
  return items.find(item => item.id === id);
}

/**
 * Siblings are read as a list, so their order must not depend on when the
 * inventory happened to be collected.
 */
function compareByProjectAndNumber(left: WorkItemChildrenEntry, right: WorkItemChildrenEntry): number {
  return left.project.projectKey.localeCompare(right.project.projectKey)
    || left.issueNumber - right.issueNumber;
}
