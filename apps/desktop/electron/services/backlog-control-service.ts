import type { BacklogRuntimeSummary } from "../../shared/backlog-contract.js";

type Deps = {
  summary: (workspace: string, id: string) => Promise<BacklogRuntimeSummary>;
  interrupt: (workspace: string, id: string, reason: string) => Promise<unknown>;
  confirmMerge: (workspace: string, id: string) => Promise<unknown>;
  recordStopped: (workspace: string, id: string, runId: string) => Promise<void>;
  isPidAlive?: (pid: number) => boolean;
  kill?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
};

export function createBacklogControlService(deps: Deps) {
  const isPidAlive = deps.isPidAlive ?? ((pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  });
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const locks = new Map<string, Promise<unknown>>();
  function locked(workspace: string, id: string, action: () => Promise<BacklogRuntimeSummary>) {
    const key = JSON.stringify([workspace, id]);
    const operation = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    locks.set(key, operation);
    void operation.finally(() => { if (locks.get(key) === operation) locks.delete(key); }).catch(() => undefined);
    return operation;
  }
  function signal(pid: number, value: "SIGTERM" | "SIGKILL") {
    try { kill(pid, value); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }
  async function stopProcess(pid: number) {
    if (!isPidAlive(pid)) return;
    signal(pid, "SIGTERM");
    const timeout = deps.stopTimeoutMs ?? 2_000;
    const waitUntil = Date.now() + timeout;
    while (isPidAlive(pid) && Date.now() < waitUntil) await sleep(Math.min(50, waitUntil - Date.now()));
    if (!isPidAlive(pid)) return;
    signal(pid, "SIGKILL");
    const killedUntil = Date.now() + timeout;
    while (isPidAlive(pid) && Date.now() < killedUntil) await sleep(Math.min(50, killedUntil - Date.now()));
    if (isPidAlive(pid)) throw new Error("AFK 进程仍在运行，无法转为人工处理");
  }
  async function interrupt(workspace: string, id: string, reason: string) {
    const current = await deps.summary(workspace, id);
    if (current.backlog.state === "in_progress" || current.backlog.state === "verification") {
      await deps.interrupt(workspace, id, reason);
      return deps.summary(workspace, id);
    }
    return current;
  }
  return {
    stop(workspace: string, id: string) {
      return locked(workspace, id, async () => {
        const { activeRun, runtime } = await deps.summary(workspace, id);
        if (runtime?.status === "running" && !activeRun?.pid) throw new Error("未找到当前运行的 Worker，无法停止执行");
        if (activeRun && (activeRun.status === "running" || activeRun.status === "starting")) {
          if (activeRun.pid !== undefined) await stopProcess(activeRun.pid);
          await deps.recordStopped(workspace, id, activeRun.id);
        }
        return interrupt(workspace, id, "用户从桌面停止执行");
      });
    },
    recover(workspace: string, id: string) {
      return locked(workspace, id, async () => {
        const current = await deps.summary(workspace, id);
        if (current.runtime?.status !== "stale") throw new Error(`Backlog ${id} 当前没有 stale runtime`);
        if (current.activeRun?.pid !== undefined && isPidAlive(current.activeRun.pid)) throw new Error("AFK 进程仍在运行");
        const checked = await deps.summary(workspace, id);
        if (checked.runtime?.status !== "stale") throw new Error("runtime 已恢复，不再 stale");
        if (checked.activeRun?.pid !== undefined && isPidAlive(checked.activeRun.pid)) throw new Error("AFK 进程已恢复");
        return interrupt(workspace, id, "桌面恢复 stale 运行");
      });
    },
    confirmMerge(workspace: string, id: string) {
      return locked(workspace, id, async () => {
        await deps.confirmMerge(workspace, id);
        return deps.summary(workspace, id);
      });
    },
  };
}
