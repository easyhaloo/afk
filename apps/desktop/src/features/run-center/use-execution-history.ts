import { useEffect, useRef, useState } from "react";
import type { ExecutionQueryOptions, ExecutionSummary } from "../../../shared/execution-contract.js";

type Page = { executions: ExecutionSummary[]; nextCursor?: string };
type History = Page & { workItemId?: string; error: string; paginated: boolean };

export function useExecutionHistory(enabled: boolean, workItemId?: string) {
  const [history, setHistory] = useState<History>({ workItemId, executions: [], error: "", paginated: false });
  const generation = useRef(0);
  const lookup = useRef(0);
  const loadingMore = useRef(false);

  const mergePage = (page: Page, mode: "refresh" | "more" | "lookup", version: number) => {
    setHistory(current => {
      if (generation.current !== version || current.workItemId !== workItemId) return current;
      const known = new Map(current.executions.map(execution => [execution.runId, execution]));
      const incoming = new Map<string, ExecutionSummary>();
      for (const execution of page.executions) {
        if (workItemId && execution.workItemId !== workItemId) continue;
        const previous = incoming.get(execution.runId) ?? known.get(execution.runId);
        incoming.set(execution.runId, previous && previous.sequence > execution.sequence ? previous : execution);
      }
      const executions = mode === "refresh"
        ? [...incoming.values(), ...current.executions.filter(execution => !incoming.has(execution.runId))]
        : [...current.executions.map(execution => incoming.get(execution.runId) ?? execution), ...[...incoming.values()].filter(execution => !known.has(execution.runId))];
      return {
        ...current, executions, error: "",
        paginated: current.paginated || mode === "more",
        nextCursor: mode === "more" || (mode === "refresh" && !current.paginated) ? page.nextCursor : current.nextCursor,
      };
    });
  };

  const recordError = (cause: unknown, version: number) => {
    if (generation.current !== version) return;
    setHistory(current => generation.current === version && current.workItemId === workItemId
      ? { ...current, error: cause instanceof Error ? cause.message : String(cause) } : current);
  };

  useEffect(() => {
    const version = ++generation.current;
    loadingMore.current = false;
    setHistory(current => current.workItemId === workItemId ? current : { workItemId, executions: [], error: "", paginated: false });
    let refreshing = false;
    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        mergePage(await window.afkDesktop.workItems.executions({ ...(workItemId ? { workItemId } : {}), limit: 100 }), "refresh", version);
      } catch (cause) {
        recordError(cause, version);
      } finally {
        refreshing = false;
      }
    };
    if (enabled) void refresh();
    const timer = enabled ? setInterval(() => { void refresh(); }, 5000) : undefined;
    return () => { generation.current += 1; lookup.current += 1; if (timer !== undefined) clearInterval(timer); };
  }, [enabled, workItemId]);

  const loadMore = async () => {
    if (!enabled || history.workItemId !== workItemId || !history.nextCursor || loadingMore.current) return;
    const version = generation.current;
    loadingMore.current = true;
    try {
      const page = await window.afkDesktop.workItems.executions({ ...(workItemId ? { workItemId } : {}), limit: 100, since: history.nextCursor });
      mergePage(page, "more", version);
    } catch (cause) {
      recordError(cause, version);
    } finally {
      if (generation.current === version) loadingMore.current = false;
    }
  };

  const find = async (runId: string, itemId = workItemId) => {
    const version = generation.current;
    const request = ++lookup.current;
    const current = () => generation.current === version && lookup.current === request;
    const options: ExecutionQueryOptions = { ...(itemId ? { workItemId: itemId } : {}), limit: 100 };
    try {
      do {
        const page = await window.afkDesktop.workItems.executions(options);
        if (!current()) return;
        mergePage(page, "lookup", version);
        const execution = page.executions.find(candidate => candidate.runId === runId && (!itemId || candidate.workItemId === itemId));
        if (execution) return execution;
        options.since = page.nextCursor;
      } while (options.since);
      throw new Error("未找到该运行的审计记录。");
    } catch (cause) {
      if (current()) throw cause;
    }
  };

  return {
    executions: history.workItemId === workItemId ? history.executions : [],
    nextCursor: history.workItemId === workItemId ? history.nextCursor : undefined,
    error: history.workItemId === workItemId ? history.error : "",
    loadMore, find,
    cancelLookup: () => { lookup.current += 1; },
  };
}
