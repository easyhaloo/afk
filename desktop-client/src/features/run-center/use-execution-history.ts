import { useEffect, useRef, useState } from "react";
import type { ExecutionQueryOptions, ExecutionSummary } from "../../../shared/execution-contract";
import type { QueryEntry, QuerySnapshot } from "./execution-query-cache";
import {
  executionHistoryCache,
  executionHistoryKey,
  mergeExecutionPage,
  type ExecutionHistoryState,
} from "./execution-queries";

/**
 * The execution history of one work item — or of every work item.
 *
 * The hook is a thin reader of the shared history cache: the entry of the key
 * holds the records, the cursor, the error, the in-flight request and the
 * poll timer, so every surface that reads the same key reads the same truth
 * and costs one request instead of one request per surface.
 */
export function useExecutionHistory(enabled: boolean, workItemId?: string) {
  const key = executionHistoryKey(workItemId);
  const [state, setState] = useState<{ key: string; snapshot: QuerySnapshot<ExecutionHistoryState> }>(
    () => ({ key, snapshot: executionHistoryCache.read(key) }),
  );
  const observing = useRef(false);
  const generation = useRef(0);
  const lookup = useRef(0);
  const entry = useRef<QueryEntry<ExecutionHistoryState> | undefined>(undefined);

  useEffect(() => {
    const query = executionHistoryCache.entry(key);
    entry.current = query;
    // The refresh belongs to the entry: the poll and an invalidation from
    // another surface reuse it instead of asking the main process again.
    const refresh = async () => {
      try {
        const page = await window.afkDesktop.workItems.executions({ ...(workItemId ? { workItemId } : {}), limit: 100 });
        if (!query.alive) return;
        query.publish(mergeExecutionPage(query.snapshot().value, page, "refresh", workItemId));
      } catch (cause) {
        if (!query.alive) return;
        query.fail(cause instanceof Error ? cause.message : String(cause));
      }
    };
    query.setTask(refresh);
    const detach = query.subscribe(snapshot => {
      if (observing.current) setState({ key, snapshot });
    });
    setState({ key, snapshot: query.snapshot() });
    return () => { generation.current += 1; lookup.current += 1; detach(); };
  }, [key, workItemId]);

  useEffect(() => {
    observing.current = enabled;
    const query = entry.current;
    if (!enabled || !query) return;
    setState({ key, snapshot: query.snapshot() });
    void query.refresh();
    const stop = query.poll(5000);
    return () => { generation.current += 1; stop(); };
  }, [enabled, key]);

  const loadMore = async () => {
    const query = entry.current;
    if (!enabled || !query) return;
    const since = query.snapshot().value.nextCursor;
    if (!since) return;
    await query.request("more", async () => {
      try {
        const page = await window.afkDesktop.workItems.executions({ ...(workItemId ? { workItemId } : {}), limit: 100, since });
        if (!query.alive) return;
        query.publish(mergeExecutionPage(query.snapshot().value, page, "more", workItemId));
      } catch (cause) {
        if (!query.alive) return;
        query.fail(cause instanceof Error ? cause.message : String(cause));
      }
    });
  };

  const find = async (runId: string, itemId = workItemId) => {
    const query = entry.current;
    if (!query) return undefined;
    const version = generation.current;
    const request = ++lookup.current;
    const current = () => generation.current === version && lookup.current === request;
    const options: ExecutionQueryOptions = { ...(itemId ? { workItemId: itemId } : {}), limit: 100 };
    try {
      do {
        const page = await window.afkDesktop.workItems.executions(options);
        if (!current()) return;
        if (query.alive) query.publish(mergeExecutionPage(query.snapshot().value, page, "lookup", workItemId));
        const execution = page.executions.find(candidate => candidate.runId === runId && (!itemId || candidate.workItemId === itemId));
        if (execution) return execution;
        options.since = page.nextCursor;
      } while (options.since);
      throw new Error("未找到该运行的审计记录。");
    } catch (cause) {
      if (current()) throw cause;
    }
  };

  const current = state.key === key;
  return {
    executions: current ? state.snapshot.value.executions : [],
    nextCursor: current ? state.snapshot.value.nextCursor : undefined,
    error: current ? state.snapshot.error : "",
    loadMore, find,
    cancelLookup: () => { lookup.current += 1; },
  };
}
