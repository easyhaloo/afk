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
});
