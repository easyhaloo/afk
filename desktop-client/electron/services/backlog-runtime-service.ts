import { homedir } from "node:os";
import { AFK_RUNTIME_TASKS_DIRECTORY } from '@afk/core';
import { probeProcess } from "@afk/infrastructure";
import path from "node:path";
import { TaskRuntimeReader } from "@afk/execution/application/runtime/task-runtime";
import type { BacklogRuntimeProjection, BacklogRuntimeSummary, BacklogRunSummary } from "../../shared/backlog-contract.js";
import { parseBacklogRuntimeSummary } from "../../shared/backlog-contract.js";
import type { createBacklogRunStore } from "./backlog-run-store.js";

export type BacklogRuntimeServiceDeps = {
  resolveWorkspace: (input: string) => string;
  getBacklog: (workspace: string, id: string) => Promise<BacklogRuntimeSummary["backlog"]>;
  runStore: ReturnType<typeof createBacklogRunStore>;
  runtimeRoot?: (workspace: string) => string;
  now?: () => number;
  isPidAlive?: (pid: number) => boolean;
};


export function createBacklogRuntimeService(deps: BacklogRuntimeServiceDeps) {
  const now = deps.now ?? Date.now;
  // A run is failed because its process exited only when the probe says
  // so. An inconclusive probe - a process that belongs to another user
  // refuses the signal - is not evidence that the run is over.
  const isPidAlive = deps.isPidAlive ?? ((pid: number) => probeProcess(pid) !== false);

  async function loadRuntime(
    workspace: string,
    backlogId: string,
    context?: { providerRef: string; startedAfter?: string },
  ): Promise<BacklogRuntimeProjection | undefined> {
    const resolvedWorkspace = deps.resolveWorkspace(workspace);
    const root = deps.runtimeRoot?.(workspace) ?? path.join(homedir(), AFK_RUNTIME_TASKS_DIRECTORY);
    // The runtime owns the records: the buckets, the file names, the
    // validation, the identity rule and the staleness window. This service
    // only asks for the records of this work item and projects them.
    const reader = new TaskRuntimeReader({ root, now });
    const entries = await reader.list({
      identity: { backlogId, workItemId: context?.providerRef, workspace: resolvedWorkspace },
      ...(context?.startedAfter !== undefined ? { startedAfter: context.startedAfter } : {}),
    });
    const latest = entries[0];
    if (!latest) return undefined;
    const record = latest.record;
    return {
      runId: record.runId,
      status: latest.status,
      phase: record.phase,
      ...(record.progress === undefined ? {} : { progress: record.progress }),
      ...(record.branch === undefined ? {} : { branch: record.branch }),
      ...(record.worktree === undefined ? {} : { worktree: record.worktree }),
      ...(record.diagnosticPath === undefined ? {} : { diagnosticPath: record.diagnosticPath }),
      heartbeatAt: record.heartbeatAt,
    };
  }

  async function summary(workspace: string, backlogId: string): Promise<BacklogRuntimeSummary> {
    const backlog = await deps.getBacklog(workspace, backlogId);
    const runs = await deps.runStore.load(workspace);
    const activeRun = runs
      .filter(run => run.backlogId === backlogId)
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
    const runtime = await loadRuntime(workspace, backlogId, {
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
