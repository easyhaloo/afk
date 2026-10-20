import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryCache } from "./execution-query-cache";

describe("execution query cache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("joins a second request on the same key instead of starting another", async () => {
    const cache = createQueryCache<number>(() => 0);
    const entry = cache.entry("history");
    const task = vi.fn(async () => { await Promise.resolve(); });
    entry.setTask(task);

    const first = entry.refresh();
    const second = entry.refresh();
    expect(task).toHaveBeenCalledOnce();
    await Promise.all([first, second]);
    expect(task).toHaveBeenCalledOnce();

    await entry.refresh();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("keeps one poll timer per key however many subscribers there are", async () => {
    const cache = createQueryCache<number>(() => 0);
    const entry = cache.entry("history");
    const task = vi.fn(async () => { await Promise.resolve(); });
    entry.setTask(task);

    const stopFirst = entry.poll(5000);
    const stopSecond = entry.poll(5000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledOnce();

    stopFirst();
    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledTimes(2);

    stopSecond();
    await vi.advanceTimersByTimeAsync(15000);
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("tells every subscriber of a key to refetch when the key is invalidated", async () => {
    const cache = createQueryCache<number>(() => 0);
    const entry = cache.entry("history");
    let calls = 0;
    entry.setTask(async () => { calls += 1; entry.publish(calls); });
    const seen: number[] = [];
    const detachFirst = entry.subscribe(snapshot => seen.push(snapshot.value));
    const detachSecond = entry.subscribe(snapshot => seen.push(snapshot.value));

    await entry.refresh();
    expect(calls).toBe(1);
    expect(seen).toEqual([1, 1]);

    entry.invalidate();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(2);
    expect(seen).toEqual([1, 1, 2, 2]);

    detachFirst();
    detachSecond();
  });

  it("keeps the entries of two keys apart", () => {
    const cache = createQueryCache<string[]>(() => []);
    const first = cache.entry("history:a");
    const second = cache.entry("history:b");
    first.publish(["a"]);

    expect(first.snapshot().value).toEqual(["a"]);
    expect(second.snapshot().value).toEqual([]);
    expect(cache.read("history:b").value).toEqual([]);
  });

  it("stops the poll and frees the key when the last subscriber leaves", async () => {
    const cache = createQueryCache<number>(() => 0);
    const entry = cache.entry("history");
    const task = vi.fn(async () => { await Promise.resolve(); });
    entry.setTask(task);
    const detach = entry.subscribe(() => {});
    entry.poll(5000);

    await vi.advanceTimersByTimeAsync(5000);
    expect(task).toHaveBeenCalledOnce();

    detach();
    await vi.advanceTimersByTimeAsync(15000);
    expect(task).toHaveBeenCalledOnce();
    expect(entry.alive).toBe(false);
    expect(cache.entry("history")).not.toBe(entry);
  });

  it("drops a response that arrives after the last subscriber left", async () => {
    const cache = createQueryCache<number>(() => 0);
    const entry = cache.entry("history");
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    entry.setTask(async () => { await gate; entry.publish(1); });
    const detach = entry.subscribe(() => {});

    const request = entry.refresh();
    detach();
    release();
    await request;

    expect(entry.alive).toBe(false);
    expect(entry.snapshot().value).toBe(0);
  });
});
