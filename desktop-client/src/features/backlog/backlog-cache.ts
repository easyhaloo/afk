import type { BacklogItem } from "../../../shared/backlog-contract";

export const BACKLOG_CACHE_TTL_MS = 30_000;

export type BacklogCacheEntry = {
  items: BacklogItem[];
  fetchedAt: number;
};

type FetchOptions = { now?: number };

type BacklogListFetcher = () => Promise<BacklogItem[]>;

/**
 * The cache is keyed by the workspace it holds.
 *
 * The desktop can look at more than one workspace, and a backlog belongs
 * to exactly one of them. A cache that kept a single slot would hand the
 * previous workspace's backlog to the new one — the previous repository's
 * work items, under the new repository's name — for as long as the entry
 * was fresh. The pending fetch is keyed the same way, so one workspace's
 * request is never answered with another workspace's.
 */
const cache = new Map<string, BacklogCacheEntry>();
const inFlight = new Map<string, { promise: Promise<BacklogItem[]>; epoch: number }>();

/**
 * Bumped when the cache is invalidated. A request that started before the
 * bump must not write its result: the invalidation asked for the data to
 * be gone.
 */
let epoch = 0;

export function readBacklogCache(key: string): BacklogCacheEntry | null {
  return cache.get(key) ?? null;
}

export function isBacklogCacheFresh(entry: BacklogCacheEntry | null, now = Date.now()): boolean {
  return entry !== null && now - entry.fetchedAt < BACKLOG_CACHE_TTL_MS;
}

export function writeBacklogCache(key: string, entry: BacklogCacheEntry): void {
  cache.set(key, entry);
}

export function invalidateBacklogCache(): void {
  epoch += 1;
  cache.clear();
}

export function resetBacklogCache(): void {
  epoch += 1;
  cache.clear();
  inFlight.clear();
}

export function fetchBacklogList(key: string, fetcher: BacklogListFetcher, options: FetchOptions = {}): Promise<BacklogItem[]> {
  const now = options.now ?? Date.now();
  const cached = readBacklogCache(key);
  if (isBacklogCacheFresh(cached, now)) return Promise.resolve(cached!.items);
  const pending = inFlight.get(key);
  if (pending && pending.epoch === epoch) return pending.promise;

  const startedAt = epoch;
  const request = fetcher().then((items) => {
    if (epoch === startedAt && inFlight.get(key)?.promise === request) writeBacklogCache(key, { items, fetchedAt: now });
    return items;
  }).finally(() => {
    if (inFlight.get(key)?.promise === request) inFlight.delete(key);
  });
  inFlight.set(key, { promise: request, epoch: startedAt });
  return request;
}
