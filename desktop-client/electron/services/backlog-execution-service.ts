import {
  confirmBacklogMerge,
  interruptBacklog,
  type BacklogChangeProvider,
  type QABacklogProvider,
} from "@afk/application";
import type { BacklogRunSummary, BacklogRuntimeSummary } from "../../shared/backlog-contract.js";
import type { createBacklogRunStore } from "./backlog-run-store.js";

type BacklogSpawnOptions = { cwd: string; detached: boolean; stdio: "ignore"; env?: NodeJS.ProcessEnv };

export type BacklogExecutionServiceDeps = {
  resolveWorkspace: (input: string) => string;
  /**
   * Resolve the backlog control ports for a workspace. The control commands
   * are application use cases, so the desktop calls them in process rather
   * than through a CLI subprocess.
   */
  providers: (workspace: string) => Promise<{
    backlog: QABacklogProvider;
    changes: BacklogChangeProvider;
  }>;
  /** The branch a confirmed merge must target. */
  targetBranch: (workspace: string) => Promise<string>;
  getSummary?: (workspace: string, id: string) => Promise<BacklogRuntimeSummary>;
  invalidateBacklogList?: () => void;
  store: ReturnType<typeof createBacklogRunStore>;
};

export function createBacklogExecutionService(deps: BacklogExecutionServiceDeps) {
  const operationLocks = new Map<string, Promise<void>>();
  let storeWrite = Promise.resolve();

  function withStore<T>(action: () => Promise<T>): Promise<T> {
    const operation = storeWrite.then(action);
    storeWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function update(workspace: string, run: BacklogRunSummary): Promise<void> {
    await withStore(async () => {
      const stored = await deps.store.load(workspace);
      const next = stored.some((item) => item.id === run.id)
        ? stored.map((item) => item.id === run.id ? run : item)
        : [...stored, run];
      await deps.store.save(workspace, next);
    });
  }

  async function updateRunning(workspace: string, run: BacklogRunSummary): Promise<void> {
    await withStore(async () => {
      const stored = await deps.store.load(workspace);
      const current = stored.find((item) => item.id === run.id);
      if (current && current.status !== "running") return;
      const next = current
        ? stored.map((item) => item.id === run.id ? run : item)
        : [...stored, run];
      await deps.store.save(workspace, next);
    });
  }

  async function withLock<T>(backlogId: string, action: () => Promise<T>): Promise<T> {
    const previous = operationLocks.get(backlogId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    operationLocks.set(backlogId, queued);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (operationLocks.get(backlogId) === queued) operationLocks.delete(backlogId);
    }
  }

  async function list(workspace: string, backlogId?: string): Promise<BacklogRunSummary[]> {
    return withStore(async () => {
      const stored = await deps.store.load(workspace);
      return stored.filter((run) => !backlogId || run.backlogId === backlogId);
    });
  }

  async function stop(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    return withLock(backlogId, async () => {
      const run = (await withStore(() => deps.store.load(workspace)))
        .filter((item) => item.backlogId === backlogId && item.status === "running")
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      if (run) await update(workspace, { ...run, status: "failed", error: "用户从桌面停止执行" });
      const current = await summary(workspace, backlogId);
      if (current.backlog.state === "in_progress" || current.backlog.state === "verification") {
        await runIntent(workspace, ports => interruptBacklog(ports.backlog, backlogId, "用户从桌面停止执行"));
        return summary(workspace, backlogId);
      }
      return current;
    });
  }

  async function recover(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    return withLock(backlogId, async () => {
      const initial = await summary(workspace, backlogId);
      if (initial.runtime?.status !== "stale") throw new Error(`Backlog ${backlogId} 当前没有 stale runtime`);
      const current = await summary(workspace, backlogId);
      if (current.runtime?.status !== "stale") throw new Error(`Backlog ${backlogId} runtime 已恢复，不再 stale`);
      if (current.backlog.state === "in_progress" || current.backlog.state === "verification") {
        await runIntent(workspace, ports => interruptBacklog(ports.backlog, backlogId, "桌面恢复 stale 运行"));
        return summary(workspace, backlogId);
      }
      return current;
    });
  }

  async function confirmMerge(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    return withLock(backlogId, async () => {
      const current = await summary(workspace, backlogId);
      if (current.backlog.parentId || current.backlog.state !== "merge_ready" || current.backlog.executionMode !== "hitl") throw new Error(`Backlog ${backlogId} 不是可确认合并的根任务`);
      const expectedTargetBranch = await deps.targetBranch(deps.resolveWorkspace(workspace));
      await runIntent(workspace, ports => confirmBacklogMerge(ports.backlog, ports.changes, backlogId, expectedTargetBranch));
      return summary(workspace, backlogId);
    });
  }

  async function runIntent(
    workspace: string,
    action: (ports: { backlog: QABacklogProvider; changes: BacklogChangeProvider }) => Promise<unknown>,
  ): Promise<void> {
    const ports = await deps.providers(deps.resolveWorkspace(workspace));
    await action(ports);
    deps.invalidateBacklogList?.();
  }

  function summary(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    if (!deps.getSummary) throw new Error("Backlog runtime summary is unavailable");
    return deps.getSummary(workspace, backlogId);
  }

  return { stop, recover, confirmMerge, list };
}
