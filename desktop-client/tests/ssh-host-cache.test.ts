import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SshListResult } from "../shared/ssh-contract";
import {
  SSH_HOST_CACHE_TTL_MS,
  fetchSshHostList,
  invalidateSshHostCache,
  isSshHostCacheFresh,
  readSshHostCache,
  resetSshHostCache,
  writeSshHostCache,
} from "../src/features/ssh/ssh-host-cache";

const result: SshListResult = { hosts: [], diagnostics: [] };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("SSH host renderer cache", () => {
  beforeEach(() => {
    resetSshHostCache();
  });

  it("stores a list result with its fetch timestamp and applies the 30 second TTL", () => {
    expect(readSshHostCache()).toBeNull();
    writeSshHostCache(result, 1_000);

    const entry = readSshHostCache();
    expect(entry).toEqual({ result, fetchedAt: 1_000 });
    expect(isSshHostCacheFresh(entry, 1_000 + SSH_HOST_CACHE_TTL_MS - 1)).toBe(true);
    expect(isSshHostCacheFresh(entry, 1_000 + SSH_HOST_CACHE_TTL_MS)).toBe(false);
  });

  it("deduplicates concurrent list requests and writes the successful result", async () => {
    let resolveRequest: ((value: SshListResult) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<SshListResult>((resolve) => { resolveRequest = resolve; }));

    const first = fetchSshHostList(fetcher, { now: 2_000 });
    const second = fetchSshHostList(fetcher, { now: 2_000 });
    expect(first).toBe(second);
    expect(fetcher).toHaveBeenCalledTimes(1);

    resolveRequest?.(result);
    await first;
    expect(readSshHostCache()).toEqual({ result, fetchedAt: 2_000 });
  });

  it("passes forceRefresh to the fetcher and does not cache rejected requests", async () => {
    writeSshHostCache(result, 3_000);
    const failure = new Error("暂时不可用");
    const fetcher = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce(result);

    await expect(fetchSshHostList(fetcher, { forceRefresh: true, now: 4_000 })).rejects.toBe(failure);
    expect(readSshHostCache()).toEqual({ result, fetchedAt: 3_000 });

    await expect(fetchSshHostList(fetcher, { forceRefresh: true, now: 5_000 })).resolves.toBe(result);
    expect(fetcher).toHaveBeenNthCalledWith(1, { forceRefresh: true });
    expect(fetcher).toHaveBeenNthCalledWith(2, { forceRefresh: true });
    expect(readSshHostCache()).toEqual({ result, fetchedAt: 5_000 });
  });

  it("uses a fresh cache without calling the fetcher and invalidates it explicitly", async () => {
    writeSshHostCache(result, 6_000);
    const fetcher = vi.fn().mockResolvedValue(result);

    await expect(fetchSshHostList(fetcher, { now: 6_000 + SSH_HOST_CACHE_TTL_MS - 1 })).resolves.toBe(result);
    expect(fetcher).not.toHaveBeenCalled();

    invalidateSshHostCache();
    expect(readSshHostCache()).toBeNull();
  });

  it.each([
    ["normal request completes first", "normal-first"],
    ["forced request completes first", "forced-first"],
  ])("starts a new forced request while a normal request is pending and keeps the forced result (%s)", async (_label, completionOrder) => {
    const normalResult: SshListResult = { hosts: [{ id: "normal", alias: "normal", hostname: "normal.test", port: 22, source: "system", configPath: "config", status: "ready" }], diagnostics: [] };
    const forcedResult: SshListResult = { hosts: [{ id: "forced", alias: "forced", hostname: "forced.test", port: 22, source: "system", configPath: "config", status: "ready" }], diagnostics: [] };
    const normal = deferred<SshListResult>();
    const forced = deferred<SshListResult>();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => normal.promise)
      .mockImplementationOnce(() => forced.promise);

    const normalRequest = fetchSshHostList(fetcher, { now: 7_000 });
    const forcedRequest = fetchSshHostList(fetcher, { forceRefresh: true, now: 7_001 });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenNthCalledWith(1, undefined);
    expect(fetcher).toHaveBeenNthCalledWith(2, { forceRefresh: true });

    if (completionOrder === "normal-first") {
      normal.resolve(normalResult);
      await normalRequest;
      expect(readSshHostCache()).toBeNull();
      forced.resolve(forcedResult);
    } else {
      forced.resolve(forcedResult);
      await forcedRequest;
      normal.resolve(normalResult);
    }
    await normalRequest;
    await expect(forcedRequest).resolves.toBe(forcedResult);
    expect(readSshHostCache()).toEqual({ result: forcedResult, fetchedAt: 7_001 });
  });

  it("does not let an invalidated request write its result back into the cache", async () => {
    const pending = deferred<SshListResult>();
    const fetcher = vi.fn(() => pending.promise);
    const request = fetchSshHostList(fetcher, { now: 8_000 });

    invalidateSshHostCache();
    pending.resolve(result);
    await request;

    expect(readSshHostCache()).toBeNull();
  });
});
