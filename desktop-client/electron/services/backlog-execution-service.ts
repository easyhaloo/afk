import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BacklogItem, BacklogRunRetryInput, BacklogRunStartInput, BacklogRunSummary, BacklogRuntimeSummary } from "../../shared/backlog-contract";
import type { createBacklogRunStore } from "./backlog-run-store";

type SpawnedProcess = Pick<ChildProcess, "pid" | "once" | "unref">;
type BacklogSpawnOptions = { cwd: string; detached: boolean; stdio: "ignore"; env?: NodeJS.ProcessEnv };
type ExecResult = { ok: boolean; stdout: string; stderr: string };
type Signal = "SIGTERM" | "SIGKILL";

export type BacklogExecutionServiceDeps = {
  resolveAfk: () => Promise<string>;
  resolveWorkspace: (input: string) => string;
  getBacklog: (workspace: string, id: string) => Promise<BacklogItem>;
  getSummary?: (workspace: string, id: string) => Promise<BacklogRuntimeSummary>;
  validateTemplate?: (workspace: string, template: string) => Promise<boolean>;
  invalidateBacklogList?: () => void;
  store: ReturnType<typeof createBacklogRunStore>;
  spawn?: (command: string, args: string[], options: BacklogSpawnOptions) => SpawnedProcess;
  exec?: (command: string, args: string[], cwd: string) => Promise<ExecResult>;
  kill?: (pid: number, signal: Signal) => void;
  isPidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
  now?: () => Date;
};

export function buildBacklogRunArgs(input: BacklogRunStartInput): string[] {
  const args = ["loop", "--backlog-id", input.backlogId, "--max-iterations", "1"];
  if (input.template) args.push("--template", input.template);
  return args;
}

export function createBacklogExecutionService(deps: BacklogExecutionServiceDeps) {
  const spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
  const now = deps.now ?? (() => new Date());
  const isPidAlive = deps.isPidAlive ?? defaultIsProcessAlive;
  const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopTimeoutMs = deps.stopTimeoutMs ?? 2_000;
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
    const afkPath = await requireAfk();
    const root = deps.resolveWorkspace(workspace);
    const startedAt = now().toISOString();
    const runId = `desktop-${input.backlogId}-${randomUUID()}`;
    const child = spawn(afkPath, buildBacklogRunArgs(input), { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, PWD: root } });
    const summary: BacklogRunSummary = {
      id: runId,
      backlogId: input.backlogId,
      status: "running",
      startedAt,
      ...(input.template ? { template: input.template } : {}),
      ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
    };
    let persisted = false;
    let pendingTerminal: BacklogRunSummary | undefined;
    const recordTerminal = (terminal: BacklogRunSummary) => {
      if (persisted) void updateRunning(workspace, terminal);
      else pendingTerminal = terminal;
    };
    child.once("error", (error: Error) => {
      deps.invalidateBacklogList?.();
      recordTerminal({ ...summary, status: "failed", error: error.message });
    });
    child.once("exit", (code: number | null) => {
      deps.invalidateBacklogList?.();
      recordTerminal({ ...summary, status: code === 0 ? "completed" : "failed", ...(code === 0 ? {} : { error: `afk loop exited with code ${code ?? "unknown"}` }) });
    });
    child.unref();
    await update(workspace, summary);
    persisted = true;
    if (pendingTerminal) await updateRunning(workspace, pendingTerminal);
    return summary;
  }

  async function start(workspace: string, input: BacklogRunStartInput): Promise<BacklogRunSummary> {
    return withLock(input.backlogId, () => startUnlocked(workspace, input));
  }

  async function list(workspace: string, backlogId?: string): Promise<BacklogRunSummary[]> {
    return withStore(async () => {
      const stored = await deps.store.load(workspace);
      const refreshed = stored.map((run) => {
        if (run.status !== "running" || run.pid === undefined || isPidAlive(run.pid)) return run;
        return { ...run, status: "failed" as const, error: "桌面应用重启后未检测到原 AFK 进程" };
      });
      if (JSON.stringify(refreshed) !== JSON.stringify(stored)) await deps.store.save(workspace, refreshed);
      return refreshed.filter((run) => !backlogId || run.backlogId === backlogId);
    });
  }

  async function stop(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    return withLock(backlogId, async () => {
      const run = (await withStore(() => deps.store.load(workspace)))
        .filter((item) => item.backlogId === backlogId && item.status === "running")
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      if (run?.pid !== undefined && isPidAlive(run.pid)) {
        safeKill(run.pid, "SIGTERM");
        const deadline = Date.now() + stopTimeoutMs;
        while (isPidAlive(run.pid) && Date.now() < deadline) await sleep(Math.min(50, deadline - Date.now()));
        if (isPidAlive(run.pid)) safeKill(run.pid, "SIGKILL");
      }
      if (run) await update(workspace, { ...run, status: "failed", error: "用户从桌面停止执行" });
      const current = await summary(workspace, backlogId);
      if (current.backlog.state === "in_progress" || current.backlog.state === "verification") {
        await runIntent(
          workspace,
          ["backlog", "interrupt", "--id", backlogId, "--reason", "用户从桌面停止执行"],
          "backlog.interrupt",
        );
        return summary(workspace, backlogId);
      }
      return current;
    });
  }

  async function recover(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    return withLock(backlogId, async () => {
      const initial = await summary(workspace, backlogId);
      if (initial.runtime?.status !== "stale") throw new Error(`Backlog ${backlogId} 当前没有 stale runtime`);
      if (initial.activeRun?.pid !== undefined && isPidAlive(initial.activeRun.pid)) throw new Error(`Backlog ${backlogId} 的 AFK 进程仍在运行`);
      const current = await summary(workspace, backlogId);
      if (current.runtime?.status !== "stale") throw new Error(`Backlog ${backlogId} runtime 已恢复，不再 stale`);
      if (current.activeRun?.pid !== undefined && isPidAlive(current.activeRun.pid)) throw new Error(`Backlog ${backlogId} 的 AFK 进程已恢复`);
      if (current.backlog.state === "in_progress" || current.backlog.state === "verification") {
        await runIntent(
          workspace,
          ["backlog", "interrupt", "--id", backlogId, "--reason", "桌面恢复 stale 运行"],
          "backlog.interrupt",
        );
        return summary(workspace, backlogId);
      }
      return current;
    });
  }

  async function retry(workspace: string, input: BacklogRunRetryInput): Promise<BacklogRunSummary> {
    return withLock(input.backlogId, async () => {
      const current = await summary(workspace, input.backlogId);
      if (current.backlog.state !== "blocked" || current.backlog.executionMode !== "hitl") throw new Error(`Backlog ${input.backlogId} 只有 blocked + hitl 状态可以重试`);
      if (current.activeRun?.pid !== undefined && isPidAlive(current.activeRun.pid)) throw new Error(`Backlog ${input.backlogId} 的 AFK 进程仍在运行`);
      if (current.runtime?.status === "running") throw new Error(`Backlog ${input.backlogId} 仍有新鲜 runtime`);
      const previous = (await withStore(() => deps.store.load(workspace)))
        .filter((run) => run.backlogId === input.backlogId)
        .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
      const template = input.template ?? previous?.template;
      await runIntent(
        workspace,
        ["backlog", "retry", "--id", input.backlogId, "--reason", input.reason],
        "backlog.retry",
      );
      return startUnlocked(workspace, { backlogId: input.backlogId, ...(template ? { template } : {}) });
    });
  }

  async function confirmMerge(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    return withLock(backlogId, async () => {
      const current = await summary(workspace, backlogId);
      if (current.backlog.parentId || current.backlog.state !== "merge_ready" || current.backlog.executionMode !== "hitl") throw new Error(`Backlog ${backlogId} 不是可确认合并的根任务`);
      await runIntent(workspace, ["backlog", "confirm-merge", "--id", backlogId], "backlog.confirm-merge");
      return summary(workspace, backlogId);
    });
  }

  async function runIntent(workspace: string, args: string[], kind: string): Promise<void> {
    if (!deps.exec) throw new Error("AFK backlog control executor is unavailable");
    const afkPath = await requireAfk();
    const result = await deps.exec(afkPath, [...args, "--json"], deps.resolveWorkspace(workspace));
    let envelope: unknown;
    try {
      envelope = JSON.parse(result.stdout);
    } catch {
      throw new Error(result.stderr || "AFK backlog control returned invalid JSON");
    }
    if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) throw new Error("AFK backlog control returned an invalid JSON envelope");
    const parsed = envelope as { ok?: unknown; kind?: unknown; error?: { message?: unknown } };
    if (parsed.kind !== kind) throw new Error(`AFK backlog control returned unexpected kind: ${String(parsed.kind)}`);
    if (parsed.ok !== true) throw new Error(typeof parsed.error?.message === "string" ? parsed.error.message : result.stderr || "AFK backlog control failed");
    if (!result.ok) throw new Error("AFK backlog control failed");
    deps.invalidateBacklogList?.();
  }

  async function requireAfk(): Promise<string> {
    const afkPath = await deps.resolveAfk();
    if (!afkPath) throw new Error("afk CLI 未在 PATH 中发现；请安装或设置 PATH");
    return afkPath;
  }

  function summary(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    if (!deps.getSummary) throw new Error("Backlog runtime summary is unavailable");
    return deps.getSummary(workspace, backlogId);
  }

  function safeKill(pid: number, signal: Signal): void {
    try {
      kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  return { start, stop, recover, retry, confirmMerge, list };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
