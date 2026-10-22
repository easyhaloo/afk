import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { RUNTIME_STALE_AFTER_MS } from "@afk/application";
import type { BacklogRuntimeProjection, BacklogRuntimeSummary, BacklogRunSummary, WorkItemRunRecord } from "../../shared/backlog-contract.js";
import { parseBacklogRuntimeSummary } from "../../shared/backlog-contract.js";

type RuntimeRecord = BacklogRuntimeProjection & {
  backlogId: string;
  workspace?: string;
  providerRef?: string;
  worktree?: string;
  startedAt: string;
};

export type BacklogRuntimeServiceDeps = {
  resolveWorkspace: (input: string) => string;
  getBacklog: (workspace: string, id: string) => Promise<BacklogRuntimeSummary["backlog"]>;
  latestRun: (workItemId: string) => Promise<WorkItemRunRecord | undefined>;
  runtimeRoot?: (workspace: string) => string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
};


export function createBacklogRuntimeService(deps: BacklogRuntimeServiceDeps) {
  const now = deps.now ?? Date.now;
  const isPidAlive = deps.isPidAlive ?? ((pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  });

  async function loadRuntime(
    workspace: string,
    backlogId: string,
    context?: { providerRef: string; startedAfter?: string },
  ): Promise<BacklogRuntimeProjection | undefined> {
    const resolvedWorkspace = deps.resolveWorkspace(workspace);
    const root = deps.runtimeRoot?.(workspace) ?? path.join(process.env.HOME || process.env.USERPROFILE || resolvedWorkspace, ".afk", "runtime", "tasks");
    const startedAfter = context?.startedAfter === undefined ? undefined : Date.parse(context.startedAfter);
    const records: RuntimeRecord[] = [];
    for (const bucket of ["active", "archive"]) {
      const directory = path.join(root, bucket);
      const names = await readdir(directory).catch(() => [] as string[]);
      for (const name of names.filter(item => item.endsWith(".json"))) {
        const raw = await readFile(path.join(directory, name), "utf8").catch(() => "");
        if (!raw) continue;
        try {
          const value = JSON.parse(raw) as Partial<RuntimeRecord>;
          if (value.backlogId !== backlogId || typeof value.runId !== "string" || typeof value.status !== "string" || typeof value.phase !== "string" || typeof value.heartbeatAt !== "string" || typeof value.startedAt !== "string") continue;
          if (!["running", "completed", "blocked", "failed"].includes(value.status) || !["implementing", "verifying"].includes(value.phase)) continue;
          const heartbeatAt = Date.parse(value.heartbeatAt);
          const runtimeStartedAt = Date.parse(value.startedAt);
          if (!Number.isFinite(heartbeatAt) || !Number.isFinite(runtimeStartedAt)) continue;
          if (typeof value.workspace !== "string" || path.resolve(value.workspace) !== path.resolve(resolvedWorkspace)) continue;
          if (context && typeof value.providerRef === "string" && value.providerRef !== context.providerRef) continue;
          if (startedAfter !== undefined && Number.isFinite(startedAfter) && runtimeStartedAt < startedAfter) continue;
          records.push(value as RuntimeRecord);
        } catch {
          continue;
        }
      }
    }
    const latest = records.sort((left, right) => Date.parse(right.heartbeatAt) - Date.parse(left.heartbeatAt))[0];
    if (!latest) return undefined;
    const stale = latest.status === "running" && Number.isFinite(Date.parse(latest.heartbeatAt)) && now() - Date.parse(latest.heartbeatAt) > RUNTIME_STALE_AFTER_MS;
    return {
      runId: latest.runId,
      status: stale ? "stale" : latest.status,
      phase: latest.phase,
      ...(latest.progress === undefined ? {} : { progress: latest.progress }),
      ...(latest.branch === undefined ? {} : { branch: latest.branch }),
      ...(latest.worktree === undefined ? {} : { worktree: latest.worktree }),
      ...(latest.diagnosticPath === undefined ? {} : { diagnosticPath: latest.diagnosticPath }),
      heartbeatAt: latest.heartbeatAt,
    };
  }

  async function summary(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    const backlog = await deps.getBacklog(workspace, backlogId);
    const run = backlog.workItemId ? await deps.latestRun(backlog.workItemId) : undefined;
    const activeRun: BacklogRunSummary | undefined = run ? {
      id: run.id, backlogId, status: run.status, startedAt: run.startedAt,
      ...(run.workflow ? { template: run.workflow } : {}),
      ...(run.pid === undefined ? {} : { pid: run.pid }),
      ...(run.error ? { error: run.error } : {}),
    } : undefined;
    const runtime = await loadRuntime(run?.workspacePath ?? workspace, backlogId, {
      providerRef: backlog.providerRef,
      ...(activeRun ? { startedAfter: activeRun.startedAt } : {}),
    });
    let reconciledRun: BacklogRunSummary | undefined = activeRun;
    if (!runtime && activeRun && activeRun.status !== "failed" && (activeRun.status === "completed" || (typeof activeRun.pid === "number" && !isPidAlive(activeRun.pid)))) {
      reconciledRun = { ...activeRun, status: "failed", error: activeRun.error ?? "AFK process exited before writing a canonical runtime record" };
    }
    return parseBacklogRuntimeSummary({ backlogId, backlog, ...(reconciledRun ? { activeRun: reconciledRun } : {}), ...(runtime ? { runtime } : {}) });
  }

  return { summary, loadRuntime };
}
