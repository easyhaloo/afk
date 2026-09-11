import type { BacklogItem } from "../../../shared/backlog-contract";

export const BACKLOG_CACHE_TTL_MS = 30_000;

export type BacklogCacheEntry = {
  items: BacklogItem[];
  fetchedAt: number;
};

type FetchOptions = { now?: number };

type BacklogListFetcher = () => Promise<BacklogItem[]>;

let cache: BacklogCacheEntry | null = null;
let cacheGeneration = 0;
let inFlight: { generation: number; promise: Promise<BacklogItem[]> } | null = null;

export function readBacklogCache(_key: string): BacklogCacheEntry | null {
  // The renderer side keeps one logical cache slot per workspace; the
  // workspace key is part of the fetcher's identity so we deliberately
  // ignore the parameter here. Future per-workspace caching can layer
  // on top without changing call sites.
  return cache;
}

export function isBacklogCacheFresh(entry: BacklogCacheEntry | null, now = Date.now()): boolean {
  return entry !== null && now - entry.fetchedAt < BACKLOG_CACHE_TTL_MS;
}

export function writeBacklogCache(_key: string, entry: BacklogCacheEntry): void {
  cache = entry;
}

export function invalidateBacklogCache(): void {
  cacheGeneration += 1;
  cache = null;
}

export function resetBacklogCache(): void {
  cacheGeneration += 1;
  cache = null;
  inFlight = null;
}

export function fetchBacklogList(key: string, fetcher: BacklogListFetcher, options: FetchOptions = {}): Promise<BacklogItem[]> {
  const now = options.now ?? Date.now();
  const cached = readBacklogCache(key);
  if (isBacklogCacheFresh(cached, now)) return Promise.resolve(cached!.items);
  if (inFlight?.generation === cacheGeneration) return inFlight.promise;

  cacheGeneration += 1;
  const generation = cacheGeneration;
  const request = fetcher().then((items) => {
    if (cacheGeneration === generation && inFlight?.promise === request) writeBacklogCache(key, { items, fetchedAt: now });
    return items;
  }).finally(() => {
    if (inFlight?.promise === request) inFlight = null;
  });
  inFlight = { generation, promise: request };
  return request;
}
