import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKLOG_CACHE_TTL_MS,
  readBacklogCache,
  isBacklogCacheFresh,
  writeBacklogCache,
  invalidateBacklogCache,
  resetBacklogCache,
  fetchBacklogList,
} from "../src/features/backlog/backlog-cache";
import type { BacklogItem } from "../shared/backlog-contract";

function stubItem(id: string): BacklogItem {
  return {
    id, title: `task ${id}`,
    dependsOn: [], state: "ready", executionMode: "afk", tags: [],
    branchName: `afk/backlog-${id}`, providerRef: `stub:${id}`,
  };
}

afterEach(() => resetBacklogCache());

describe("backlog-cache", () => {
  it("exposes the canonical TTL constant", () => {
    expect(BACKLOG_CACHE_TTL_MS).toBe(30_000);
  });

  it("returns null when no cache entry exists", () => {
    expect(readBacklogCache("missing")).toBeNull();
  });

  it("isBacklogCacheFresh returns true inside the TTL and false at/after", () => {
    writeBacklogCache("k1", { items: [], fetchedAt: 1_000 });
    expect(isBacklogCacheFresh(readBacklogCache("k1"), 30_999)).toBe(true);
    expect(isBacklogCacheFresh(readBacklogCache("k1"), 31_000)).toBe(false);
    expect(isBacklogCacheFresh(readBacklogCache("k1"), 31_001)).toBe(false);
  });

  it("fetchBacklogList returns cached items inside the TTL without invoking the fetcher", async () => {
    const fetcher = vi.fn(async () => [stubItem("1")]);
    writeBacklogCache("k1", { items: [stubItem("cached")], fetchedAt: Date.now() });
    const items = await fetchBacklogList("k1", fetcher);
    expect(items).toEqual([stubItem("cached")]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fetchBacklogList invokes the fetcher on cache miss and writes the result", async () => {
    const fetcher = vi.fn(async () => [stubItem("1")]);
    const items = await fetchBacklogList("k1", fetcher);
    expect(items).toEqual([stubItem("1")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(readBacklogCache("k1")?.items).toEqual([stubItem("1")]);
  });

  it("fetchBacklogList de-duplicates concurrent in-flight fetches", async () => {
    let resolveFetcher: (value: BacklogItem[]) => void = () => undefined;
    const fetcher = vi.fn(() => new Promise<BacklogItem[]>(resolve => { resolveFetcher = resolve; }));
    const first = fetchBacklogList("k1", fetcher);
    const second = fetchBacklogList("k1", fetcher);
    resolveFetcher([stubItem("1")]);
    expect(await first).toEqual([stubItem("1")]);
    expect(await second).toEqual([stubItem("1")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("invalidateBacklogCache clears entries", async () => {
    const fetcher = vi.fn(async () => [stubItem("1")]);
    await fetchBacklogList("k1", fetcher);
    expect(readBacklogCache("k1")?.items).toEqual([stubItem("1")]);
    invalidateBacklogCache();
    expect(readBacklogCache("k1")).toBeNull();
  });

  it("invalidates again on subsequent calls without throwing", () => {
    writeBacklogCache("k1", { items: [stubItem("1")], fetchedAt: Date.now() });
    invalidateBacklogCache();
    expect(() => invalidateBacklogCache()).not.toThrow();
    expect(readBacklogCache("k1")).toBeNull();
  });

  it("uses the supplied timestamp when checking cache freshness via the now option", async () => {
    const fetcher = vi.fn(async () => [stubItem("1")]);
    writeBacklogCache("k1", { items: [stubItem("cached")], fetchedAt: 1_000 });

    // Inside TTL (1000 + 29999 < 30000 since 'now=31000'): fresh, no fetch.
    expect(await fetchBacklogList("k1", fetcher, { now: 30_999 })).toEqual([stubItem("cached")]);
    expect(fetcher).not.toHaveBeenCalled();

    // At the boundary the entry is considered stale and the fetcher runs.
    expect(await fetchBacklogList("k1", fetcher, { now: 31_000 })).toEqual([stubItem("1")]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("resets the in-flight promise so a fresh fetch after reset hits its own fetcher", async () => {
    let resolveFirst!: (value: BacklogItem[]) => void;
    const firstFetcher = vi.fn(() => new Promise<BacklogItem[]>((resolve) => { resolveFirst = resolve; }));

    // First call kicks off an in-flight request that we never resolve here.
    const inflight = fetchBacklogList("k1", firstFetcher);
    expect(firstFetcher).toHaveBeenCalledTimes(1);

    // A second concurrent call shares the in-flight promise.
    const shared = fetchBacklogList("k1", firstFetcher);
    expect(firstFetcher).toHaveBeenCalledTimes(1);

    // Reset clears the in-flight tracking; the pending request is still in memory
    // but a new fetch must NOT piggyback on it.
    resetBacklogCache();

    const thirdFetcher = vi.fn(async () => [stubItem("3")]);
    const third = fetchBacklogList("k1", thirdFetcher);
    expect(thirdFetcher).toHaveBeenCalledTimes(1);
    await expect(third).resolves.toEqual([stubItem("3")]);

    // Resolve the original pending fetch; it must not overwrite the cache that
    // the third call already wrote.
    resolveFirst([stubItem("1")]);
    await expect(inflight).resolves.toEqual([stubItem("1")]);
    await expect(shared).resolves.toEqual([stubItem("1")]);
    expect(readBacklogCache("k1")?.items).toEqual([stubItem("3")]);
  });

  it("ignores stale resolved results after a manual invalidation", async () => {
    const fetcher = vi.fn(async () => [stubItem("1")]);
    await fetchBacklogList("k1", fetcher);
    expect(readBacklogCache("k1")?.items).toEqual([stubItem("1")]);

    invalidateBacklogCache();
    await expect(fetchBacklogList("k1", fetcher)).resolves.toEqual([stubItem("1")]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readBacklogCache("k1")?.items).toEqual([stubItem("1")]);
  });
});
