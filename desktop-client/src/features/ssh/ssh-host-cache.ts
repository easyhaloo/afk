import type { SshListResult } from "../../../shared/ssh-contract";

export const SSH_HOST_CACHE_TTL_MS = 30_000;

export type SshHostCacheEntry = {
  result: SshListResult;
  fetchedAt: number;
};

type SshListOptions = {
  forceRefresh?: boolean;
};

type FetchOptions = SshListOptions & {
  now?: number;
};

type SshHostListFetcher = (options?: SshListOptions) => Promise<SshListResult>;

let cacheEntry: SshHostCacheEntry | null = null;
let cacheGeneration = 0;
let inFlight: { generation: number; promise: Promise<SshListResult> } | null = null;

export function readSshHostCache() {
  return cacheEntry;
}

export function isSshHostCacheFresh(entry: SshHostCacheEntry | null, now = Date.now()) {
  return entry !== null && now - entry.fetchedAt < SSH_HOST_CACHE_TTL_MS;
}

export function writeSshHostCache(result: SshListResult, fetchedAt = Date.now()) {
  cacheEntry = { result, fetchedAt };
}

export function invalidateSshHostCache() {
  cacheGeneration += 1;
  cacheEntry = null;
}

export function resetSshHostCache() {
  cacheGeneration += 1;
  cacheEntry = null;
  inFlight = null;
}

export function fetchSshHostList(fetcher: SshHostListFetcher, options: FetchOptions = {}) {
  const forceRefresh = options.forceRefresh === true;
  const now = options.now ?? Date.now();
  if (!forceRefresh && isSshHostCacheFresh(cacheEntry, now)) return Promise.resolve(cacheEntry!.result);
  if (!forceRefresh && inFlight?.generation === cacheGeneration) return inFlight.promise;

  if (forceRefresh) cacheGeneration += 1;
  const generation = cacheGeneration;
  let request: Promise<SshListResult>;
  request = fetcher(forceRefresh ? { forceRefresh: true } : undefined)
    .then((result) => {
      if (cacheGeneration === generation && inFlight?.promise === request) writeSshHostCache(result, now);
      return result;
    })
    .finally(() => {
      if (inFlight?.promise === request) inFlight = null;
    });
  inFlight = { generation, promise: request };
  return request;
}
