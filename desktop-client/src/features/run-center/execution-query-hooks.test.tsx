import { Fragment, createElement } from "react";
import { act, create } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionQueryOptions, ExecutionSummary } from "../../../shared/execution-contract";
import { invalidateExecutionHistory } from "./execution-queries";
import { useExecutionHistory } from "./use-execution-history";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Page = { executions: ExecutionSummary[]; nextCursor?: string };
type History = ReturnType<typeof useExecutionHistory>;

const workItemId = "github:acme/api#1";
const run = (runId: string, sequence = 1): ExecutionSummary => ({
  runId, workItemId, profileId: "default", attempt: 1, status: "running", sequence, terminal: false, integrityValid: true,
});

describe("shared execution history", () => {
  let renderer: ReturnType<typeof create> | undefined;
  const load = vi.fn<[ExecutionQueryOptions], Promise<Page>>();
  const seen: { first?: History; second?: History } = {};

  function First({ itemId }: { itemId?: string }) {
    seen.first = useExecutionHistory(true, itemId);
    return null;
  }
  function Second({ itemId }: { itemId?: string }) {
    seen.second = useExecutionHistory(true, itemId);
    return null;
  }
  function Surfaces({ itemId, first = true, second = true }: { itemId?: string; first?: boolean; second?: boolean }) {
    return createElement(Fragment, null,
      first ? createElement(First, { itemId }) : null,
      second ? createElement(Second, { itemId }) : null);
  }

  beforeEach(() => {
    vi.useFakeTimers();
    load.mockReset();
    seen.first = undefined;
    seen.second = undefined;
    vi.stubGlobal("window", { afkDesktop: { workItems: { executions: load } } });
  });

  afterEach(() => {
    if (renderer) act(() => renderer!.unmount());
    renderer = undefined;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks the main process once for two subscribers of the same key", async () => {
    load.mockResolvedValue({ executions: [run("latest")] });
    await act(async () => { renderer = create(createElement(Surfaces, { itemId: workItemId })); });

    expect(load).toHaveBeenCalledOnce();
    expect(seen.first?.executions).toEqual([run("latest")]);
    expect(seen.second?.executions).toEqual([run("latest")]);
  });

  it("polls once per interval however many subscribers there are", async () => {
    load.mockResolvedValue({ executions: [] });
    await act(async () => { renderer = create(createElement(Surfaces, { itemId: workItemId })); });
    expect(load).toHaveBeenCalledOnce();

    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("refetches every subscriber of a key when that key is invalidated", async () => {
    load.mockResolvedValueOnce({ executions: [run("latest")] }).mockResolvedValue({ executions: [run("started")] });
    await act(async () => { renderer = create(createElement(Surfaces, { itemId: workItemId })); });
    expect(load).toHaveBeenCalledOnce();
    expect(seen.first?.executions.map(execution => execution.runId)).toEqual(["latest"]);

    await act(async () => { invalidateExecutionHistory(workItemId); await vi.advanceTimersByTimeAsync(0); });

    expect(load).toHaveBeenCalledTimes(2);
    // The refreshed record leads; the record the refresh already had is kept.
    expect(seen.first?.executions.map(execution => execution.runId)).toEqual(["started", "latest"]);
    expect(seen.second?.executions.map(execution => execution.runId)).toEqual(["started", "latest"]);
  });

  it("keeps the history of every work item apart from the history of one work item", async () => {
    load.mockResolvedValue({ executions: [] });
    await act(async () => {
      renderer = create(createElement(Fragment, null,
        createElement(First, {}),
        createElement(Second, { itemId: workItemId })));
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith({ limit: 100 });
    expect(load).toHaveBeenCalledWith({ workItemId, limit: 100 });
  });

  it("stops the poll when the last subscriber of a key leaves", async () => {
    load.mockResolvedValue({ executions: [] });
    await act(async () => { renderer = create(createElement(Surfaces, { itemId: workItemId })); });
    expect(load).toHaveBeenCalledOnce();

    await act(async () => { renderer!.update(createElement(Surfaces, { itemId: workItemId, second: false })); });
    const unmounted = seen.second?.executions;
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(load).toHaveBeenCalledTimes(2);
    expect(seen.second?.executions).toBe(unmounted);

    await act(async () => { renderer!.update(createElement(Surfaces, { itemId: workItemId, first: false, second: false })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
