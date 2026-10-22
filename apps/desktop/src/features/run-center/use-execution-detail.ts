import { useEffect, useRef, useState } from "react";
import type { ExecutionRunDetail } from "../../../shared/execution-contract.js";

export function useExecutionDetail(runId: string, workItemId: string, enabled: boolean, running: boolean, load: (runId: string, workItemId: string) => Promise<ExecutionRunDetail>) {
  const [detail, setDetail] = useState<ExecutionRunDetail | null>(null);
  const [error, setError] = useState("");
  const loadRef = useRef(load);
  loadRef.current = load;
  useEffect(() => {
    if (!enabled) return;
    let current = true;
    let loading = false;
    setError("");
    const refresh = () => {
      if (loading) return;
      loading = true;
      loadRef.current(runId, workItemId).then(result => {
        if (current) { setDetail(result); setError(""); }
      }).catch((cause: unknown) => {
        if (current) setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => { loading = false; });
    };
    refresh();
    const timer = running ? setInterval(refresh, 5000) : undefined;
    return () => { current = false; if (timer !== undefined) clearInterval(timer); };
  }, [enabled, running, runId, workItemId]);
  return { detail: detail?.runId === runId && detail.workItemId === workItemId ? detail : null, error };
}
