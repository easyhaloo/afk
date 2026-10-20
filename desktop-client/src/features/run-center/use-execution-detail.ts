import { useEffect, useRef, useState } from "react";
import type { ExecutionRunDetail } from "../../../shared/execution-contract";
import type { QueryEntry, QuerySnapshot } from "./execution-query-cache";
import { executionDetailCache, executionDetailKey } from "./execution-queries";

/**
 * The detail of one run.
 *
 * The hook is a thin reader of the shared detail cache: the entry of the
 * (run, work item) key holds the record, the error, the in-flight request and
 * the poll timer, so two surfaces that open the same run read the same truth
 * and cost one request instead of one request per surface.
 */
export function useExecutionDetail(runId: string, workItemId: string, enabled: boolean, running: boolean, load: (runId: string, workItemId: string) => Promise<ExecutionRunDetail>) {
  const key = executionDetailKey(runId, workItemId);
  const [state, setState] = useState<{ key: string; snapshot: QuerySnapshot<ExecutionRunDetail | null> }>(
    () => ({ key, snapshot: executionDetailCache.read(key) }),
  );
  const observing = useRef(false);
  const loadRef = useRef(load);
  loadRef.current = load;
  const entry = useRef<QueryEntry<ExecutionRunDetail | null> | undefined>(undefined);

  useEffect(() => {
    const query = executionDetailCache.entry(key);
    entry.current = query;
    // The task belongs to the entry, and reads the loader through a ref so a
    // fresh closure from the parent does not reload the run.
    const refresh = async () => {
      const result = await loadRef.current(runId, workItemId);
      if (!query.alive) return;
      query.publish(result);
    };
    query.setTask(refresh);
    const detach = query.subscribe(snapshot => {
      if (observing.current) setState({ key, snapshot });
    });
    setState({ key, snapshot: query.snapshot() });
    return () => { detach(); };
  }, [key, runId, workItemId]);

  useEffect(() => {
    observing.current = enabled;
    const query = entry.current;
    if (!enabled || !query) return;
    query.clearError();
    setState({ key, snapshot: query.snapshot() });
    void query.refresh();
    const stop = running ? query.poll(5000) : () => {};
    return () => { stop(); };
  }, [enabled, running, key]);

  const current = state.key === key;
  const detail = current ? state.snapshot.value : null;
  return {
    detail: detail?.runId === runId && detail.workItemId === workItemId ? detail : null,
    error: current ? state.snapshot.error : "",
  };
}
