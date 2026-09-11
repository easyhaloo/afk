import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { BacklogItem, BacklogRunStartInput, BacklogRunSummary } from "../../shared/backlog-contract";
import type { createBacklogRunStore } from "./backlog-run-store";

type SpawnedProcess = Pick<ChildProcess, "pid" | "once" | "unref">;
type BacklogSpawnOptions = { cwd: string; detached: boolean; stdio: "ignore"; env?: NodeJS.ProcessEnv };

export type BacklogExecutionServiceDeps = {
  resolveAfk: () => Promise<string>;
  resolveWorkspace: (input: string) => string;
  getBacklog: (workspace: string, id: string) => Promise<BacklogItem>;
  store: ReturnType<typeof createBacklogRunStore>;
  spawn?: (command: string, args: string[], options: BacklogSpawnOptions) => SpawnedProcess;
  now?: () => Date;
};

export function buildBacklogRunArgs(input: BacklogRunStartInput): string[] {
  const args = ["run", "--backlog-id", input.backlogId];
  if (input.template) args.push("--template", input.template);
  return args;
}

export function createBacklogExecutionService(deps: BacklogExecutionServiceDeps) {
  const spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
  const now = deps.now ?? (() => new Date());

  async function update(workspace: string, run: BacklogRunSummary): Promise<void> {
    const stored = await deps.store.load(workspace);
    const next = stored.some((item) => item.id === run.id)
      ? stored.map((item) => item.id === run.id ? run : item)
      : [...stored, run];
    await deps.store.save(workspace, next);
  }

  async function start(workspace: string, input: BacklogRunStartInput): Promise<BacklogRunSummary> {
    const backlog = await deps.getBacklog(workspace, input.backlogId);
    if (backlog.state !== "ready") throw new Error(`Backlog ${input.backlogId} 当前状态为 ${backlog.state}，只有 ready 项可以启动`);
    const existing = (await list(workspace, input.backlogId)).find((run) => run.status === "running");
    if (existing) return existing;
    const afkPath = await deps.resolveAfk();
    if (!afkPath) throw new Error("afk CLI 未在 PATH 中发现；请安装或设置 PATH");
    const root = deps.resolveWorkspace(workspace);
    const startedAt = now().toISOString();
    const runId = `desktop-${input.backlogId}-${randomUUID()}`;
    const args = buildBacklogRunArgs(input);
    const child = spawn(afkPath, args, { cwd: root, detached: true, stdio: "ignore", env: { ...process.env, PWD: root } });
    const summary: BacklogRunSummary = {
      id: runId,
      backlogId: input.backlogId,
      status: "running",
      startedAt,
      ...(input.template ? { template: input.template } : {}),
      ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
    };
    child.once("error", (error: Error) => {
      void update(workspace, { ...summary, status: "failed", error: error.message });
    });
    child.once("exit", (code: number | null) => {
      void update(workspace, { ...summary, status: code === 0 ? "completed" : "failed", ...(code === 0 ? {} : { error: `afk run exited with code ${code ?? "unknown"}` }) });
    });
    child.unref();
    await update(workspace, summary);
    return summary;
  }

  async function list(workspace: string, backlogId?: string): Promise<BacklogRunSummary[]> {
    const stored = await deps.store.load(workspace);
    const refreshed = stored.map((run) => {
      if (run.status !== "running" || run.pid === undefined || isProcessAlive(run.pid)) return run;
      return { ...run, status: "failed" as const, error: "桌面应用重启后未检测到原 AFK 进程" };
    });
    if (JSON.stringify(refreshed) !== JSON.stringify(stored)) await deps.store.save(workspace, refreshed);
    return refreshed.filter((run) => !backlogId || run.backlogId === backlogId);
  }

  return { start, list };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
