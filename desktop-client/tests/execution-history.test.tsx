import { createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionQueryOptions, ExecutionSummary } from "../shared/execution-contract";
import { useExecutionHistory } from "../src/features/run-center/use-execution-history";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Page = { executions: ExecutionSummary[]; nextCursor?: string };
const workItemId = "github:acme/api#1";
const run = (runId: string, sequence = 1, itemId = workItemId): ExecutionSummary => ({
  runId, workItemId: itemId, sequence, profileId: "default", attempt: 1, status: "running", terminal: false, integrityValid: true,
});

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Value>((resolveValue, rejectValue) => { resolve = resolveValue; reject = rejectValue; });
  return { promise, resolve, reject };
}

describe("execution history", () => {
  let history!: ReturnType<typeof useExecutionHistory>;
  let renderer: ReturnType<typeof create> | undefined;
  const load = vi.fn<[ExecutionQueryOptions], Promise<Page>>();

  function History({ enabled = true, itemId }: { enabled?: boolean; itemId?: string }) {
    history = useExecutionHistory(enabled, itemId);
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    load.mockReset();
    vi.stubGlobal("window", { afkDesktop: { workItems: { executions: load } } });
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps a run found beyond the latest page after polling and re-enabling", async () => {
    load.mockImplementation(async options => options.since
      ? { executions: [run("historical")] }
      : { executions: [run("latest")], nextCursor: "older" });
    await act(async () => { renderer = create(createElement(History, { enabled: false })); });
    expect(load).not.toHaveBeenCalled();
    await act(async () => { expect(await history.find("historical", workItemId)).toEqual(run("historical")); });
    await act(async () => { renderer!.update(createElement(History)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(history.executions.map(execution => execution.runId)).toEqual(["latest", "historical"]);
    expect(history.nextCursor).toBe("older");
    expect(load).toHaveBeenCalledWith({ workItemId, limit: 100, since: "older" });
  });

  it("merges pagination once, preserves its cursor, and never downgrades a newer sequence", async () => {
    const olderPage = deferred<Page>();
    load.mockResolvedValueOnce({ executions: [run("latest", 1)], nextCursor: "older" });
    await act(async () => { renderer = create(createElement(History, { itemId: workItemId })); });
    load.mockImplementation(async options => options.since
      ? olderPage.promise
      : { executions: [run("latest", 3)], nextCursor: "changed-first-page" });
    let loading!: Promise<void>;
    act(() => { loading = history.loadMore(); void history.loadMore(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    await act(async () => {
      olderPage.resolve({ executions: [run("latest", 2), run("historical")], nextCursor: "oldest" });
      await loading;
    });
    expect(load.mock.calls.filter(([options]) => options.since === "older")).toHaveLength(1);
    expect(history.executions).toEqual([run("latest", 3), run("historical")]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(history.nextCursor).toBe("oldest");
  });

  it("updates the first-page cursor until pagination starts", async () => {
    load.mockResolvedValueOnce({ executions: [run("first")] });
    await act(async () => { renderer = create(createElement(History)); });
    expect(history.nextCursor).toBeUndefined();
    load.mockResolvedValue({ executions: [run("second"), run("first")], nextCursor: "older" });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(history.nextCursor).toBe("older");
  });

  it.each(["success", "error"])("ignores stale page %s after the work item changes", async outcome => {
    const olderPage = deferred<Page>();
    load.mockImplementation(async options => options.since ? olderPage.promise : {
      executions: [run("latest", 1, options.workItemId)], nextCursor: "older",
    });
    await act(async () => { renderer = create(createElement(History, { itemId: workItemId })); });
    let loading!: Promise<void>;
    act(() => { loading = history.loadMore(); });
    const nextItemId = "github:acme/api#2";
    await act(async () => { renderer!.update(createElement(History, { itemId: nextItemId })); });
    await act(async () => {
      if (outcome === "success") olderPage.resolve({ executions: [run("stale")] });
      else olderPage.reject(new Error("obsolete error"));
      await loading;
    });
    expect(history.executions).toEqual([run("latest", 1, nextItemId)]);
    expect(history.error).toBe("");
    expect(history.nextCursor).toBe("older");
  });

  it.each(["success", "error"])("ignores a superseded lookup %s", async outcome => {
    load.mockResolvedValue({ executions: [] });
    await act(async () => { renderer = create(createElement(History)); });
    const first = deferred<Page>();
    const second = deferred<Page>();
    load.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    let firstLookup!: Promise<ExecutionSummary | undefined>;
    let secondLookup!: Promise<ExecutionSummary | undefined>;
    act(() => { firstLookup = history.find("first", workItemId); secondLookup = history.find("second", workItemId); });
    await act(async () => { second.resolve({ executions: [run("second")] }); expect(await secondLookup).toEqual(run("second")); });
    await act(async () => {
      if (outcome === "success") first.resolve({ executions: [run("first")] });
      else first.reject(new Error("obsolete lookup"));
      expect(await firstLookup).toBeUndefined();
    });
    expect(history.executions).toEqual([run("second")]);
    expect(history.error).toBe("");
  });

  it("does not overlap refreshes and stops polling when disabled", async () => {
    const pending = deferred<Page>();
    load.mockReturnValueOnce(pending.promise).mockResolvedValue({ executions: [run("latest")] });
    await act(async () => { renderer = create(createElement(History)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(load).toHaveBeenCalledOnce();
    await act(async () => { renderer!.update(createElement(History, { enabled: false })); });
    await act(async () => { pending.resolve({ executions: [run("stale")] }); await pending.promise; });
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(load).toHaveBeenCalledOnce();
    expect(history.executions).toEqual([]);
  });

  it.each(["success", "error"])("cancels a lookup %s without resetting the execution list", async outcome => {
    load.mockResolvedValue({ executions: [run("current")] });
    await act(async () => { renderer = create(createElement(History)); });
    const pending = deferred<Page>();
    load.mockReturnValueOnce(pending.promise);
    let finding!: Promise<ExecutionSummary | undefined>;
    act(() => { finding = history.find("obsolete", workItemId); history.cancelLookup(); });
    await act(async () => {
      if (outcome === "success") pending.resolve({ executions: [run("obsolete")] });
      else pending.reject(new Error("obsolete lookup"));
      expect(await finding).toBeUndefined();
    });
    expect(history.executions).toEqual([run("current")]);
    expect(history.error).toBe("");
  });
});
