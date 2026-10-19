import { randomUUID } from "node:crypto";
import {
  confirmBacklogMerge,
  interruptBacklog,
  retryBacklog,
  type BacklogChangeProvider,
  type QABacklogProvider,
} from "@afk/application";
import type { BacklogItem, BacklogRunRetryInput, BacklogRunStartInput, BacklogRunSummary, BacklogRuntimeSummary } from "../../shared/backlog-contract.js";
import type { createBacklogRunStore } from "./backlog-run-store.js";

type BacklogSpawnOptions = { cwd: string; detached: boolean; stdio: "ignore"; env?: NodeJS.ProcessEnv };

export type BacklogExecutionServiceDeps = {
  resolveWorkspace: (input: string) => string;
  /**
   * Start the execution for a backlog's work item. The desktop runs the
   * execution in process, through the same runtime the CLI drives.
   */
  startExecution: (workspace: string, input: { workItemId: string; template?: string }) => Promise<{ runId: string }>;
  /**
   * Report the state of a delegated execution, so the backlog run follows
   * the work item run it started.
   */
  executionState: (workspace: string, runId: string) => Promise<"running" | "completed" | "failed" | "unknown">;
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
  getBacklog: (workspace: string, id: string) => Promise<BacklogItem>;
  getSummary?: (workspace: string, id: string) => Promise<BacklogRuntimeSummary>;
  validateTemplate?: (workspace: string, template: string) => Promise<boolean>;
  invalidateBacklogList?: () => void;
  store: ReturnType<typeof createBacklogRunStore>;
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
  now?: () => Date;
};

export function createBacklogExecutionService(deps: BacklogExecutionServiceDeps) {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
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

  async function startUnlocked(workspace: string, input: BacklogRunStartInput): Promise<BacklogRunSummary> {
    const backlog = await deps.getBacklog(workspace, input.backlogId);
    if (backlog.state !== "ready" && backlog.state !== "rework") throw new Error(`Backlog ${input.backlogId} 当前状态为 ${backlog.state}，只有 ready/rework 项可以启动`);
    if (backlog.executionMode !== "afk") throw new Error(`Backlog ${input.backlogId} 当前模式为 ${backlog.executionMode}，只有 AFK 自动项可以启动`);
    const existing = (await list(workspace, input.backlogId)).find((run) => run.status === "running");
    if (existing) return existing;
    if (deps.getSummary) {
      const current = await deps.getSummary(workspace, input.backlogId);
      if (current.runtime?.status === "running" || current.runtime?.status === "stale") throw new Error(`Backlog ${input.backlogId} 已有 active runtime，请先处理现有运行`);
      if (current.activeRun?.status === "running") throw new Error(`Backlog ${input.backlogId} 已有运行中的 AFK 进程`);
    }
    if (input.template && deps.validateTemplate && !(await deps.validateTemplate(workspace, input.template))) {
      throw new Error(`Workflow template not found or invalid: ${input.template}`);
    }
    const workItemId = backlog.workItemId ?? backlog.id;
    const startedAt = now().toISOString();
    const runId = `desktop-${input.backlogId}-${randomUUID()}`;
    const summary: BacklogRunSummary = {
      id: runId,
      backlogId: input.backlogId,
      status: "running",
      startedAt,
      ...(input.template ? { template: input.template } : {}),
    };
    let persisted = false;
    let pendingTerminal: BacklogRunSummary | undefined;
    const recordTerminal = (terminal: BacklogRunSummary) => {
      if (persisted) void updateRunning(workspace, terminal);
      else pendingTerminal = terminal;
    };
    let executionRunId: string;
    try {
      const started = await deps.startExecution(workspace, { workItemId, ...(input.template ? { template: input.template } : {}) });
      executionRunId = started.runId;
    } catch (error) {
      deps.invalidateBacklogList?.();
      const failed: BacklogRunSummary = {
        ...summary,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      await update(workspace, failed);
      throw error;
    }
    await update(workspace, summary);
    persisted = true;
    if (pendingTerminal) await updateRunning(workspace, pendingTerminal);
    // The delegated execution owns the lifecycle; the backlog run follows it.
    void followExecution(workspace, executionRunId, summary, recordTerminal);
    return summary;
  }

  async function followExecution(
    workspace: string,
    executionRunId: string,
    summary: BacklogRunSummary,
    recordTerminal: (terminal: BacklogRunSummary) => void,
  ): Promise<void> {
    const deadline = Date.now() + (deps.stopTimeoutMs ?? 2_000) * 60;
    while (Date.now() < deadline) {
      const state = await deps.executionState(workspace, executionRunId).catch(() => "unknown" as const);
      if (state === "completed" || state === "failed") {
        deps.invalidateBacklogList?.();
        recordTerminal({
          ...summary,
          status: state === "completed" ? "completed" : "failed",
          ...(state === "completed" ? {} : { error: "工作项执行未完成" }),
        });
        return;
      }
      await (deps.sleep ?? (async (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))))(500);
    }
  }

  async function start(workspace: string, input: BacklogRunStartInput): Promise<BacklogRunSummary> {
    return withLock(input.backlogId, () => startUnlocked(workspace, input));
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

  async function retry(workspace: string, input: BacklogRunRetryInput): Promise<BacklogRunSummary> {
    return withLock(input.backlogId, async () => {
      const current = await summary(workspace, input.backlogId);
      if (current.backlog.state !== "blocked" || current.backlog.executionMode !== "hitl") throw new Error(`Backlog ${input.backlogId} 只有 blocked + hitl 状态可以重试`);
      if (current.runtime?.status === "running") throw new Error(`Backlog ${input.backlogId} 仍有新鲜 runtime`);
      const previous = (await withStore(() => deps.store.load(workspace)))
        .filter((run) => run.backlogId === input.backlogId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      const template = input.template ?? previous?.template;
      await runIntent(workspace, ports => retryBacklog(ports.backlog, input.backlogId, input.reason));
      return startUnlocked(workspace, { backlogId: input.backlogId, ...(template ? { template } : {}) });
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


  return { start, stop, recover, retry, confirmMerge, list };
}
