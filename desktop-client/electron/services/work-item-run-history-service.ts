import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { WorkItemInventoryResult, WorkItemRunRecord } from "../../shared/backlog-contract";
import type { createExecutionWorkspaceService } from "./execution-workspace-service";
import type { createWorkItemRunStore } from "./work-item-run-store";

type HistoryDeps = {
  workspace: Pick<ReturnType<typeof createExecutionWorkspaceService>, "read" | "updateRun">;
  runStore: Pick<ReturnType<typeof createWorkItemRunStore>, "update">;
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
  runtimeArchiveDirectory?: string;
};

const STARTING_GRACE_MS = 60_000;
const EXIT_EVENT_GRACE_MS = 5_000;
type RuntimeTerminal = {
  runId: string;
  backlogId: string;
  providerRef: string;
  workspace: string;
  session: string;
  phase: "implementing" | "verifying";
  sandboxProvider: string;
  executionMode: "interactive" | "batch";
  agentProvider: string;
  heartbeatAt: string;
  status: "completed" | "failed" | "blocked";
  startedAt: string;
  completedAt: string;
  errorSummary?: string;
};

function terminalRecord(value: unknown): value is RuntimeTerminal {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<RuntimeTerminal>;
  return typeof record.runId === "string" && record.runId.length > 0
    && typeof record.backlogId === "string"
    && typeof record.providerRef === "string"
    && typeof record.workspace === "string" && path.isAbsolute(record.workspace)
    && typeof record.session === "string"
    && (record.phase === "implementing" || record.phase === "verifying")
    && typeof record.sandboxProvider === "string"
    && (record.executionMode === "interactive" || record.executionMode === "batch")
    && typeof record.agentProvider === "string"
    && typeof record.heartbeatAt === "string" && Number.isFinite(Date.parse(record.heartbeatAt))
    && (record.status === "completed" || record.status === "blocked" || record.status === "failed")
    && typeof record.startedAt === "string" && Number.isFinite(Date.parse(record.startedAt))
    && typeof record.completedAt === "string" && Number.isFinite(Date.parse(record.completedAt))
    && Date.parse(record.completedAt) >= Date.parse(record.startedAt)
    && (record.errorSummary === undefined || typeof record.errorSummary === "string");
}

async function readRuntimeArchive(directory: string): Promise<RuntimeTerminal[]> {
  let names: string[];
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records = await Promise.all(names.filter(name => name.endsWith(".json")).map(async name => {
    const file = path.join(directory, name);
    try {
      if (!(await fs.lstat(file)).isFile()) return undefined;
      const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
      if (!terminalRecord(value) || name !== `${Buffer.from(value.runId, "utf8").toString("base64url")}.json`) return undefined;
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return undefined;
      throw error;
    }
  }));
  return records.filter((record): record is RuntimeTerminal => record !== undefined);
}

function matchesRuntime(
  record: RuntimeTerminal,
  run: WorkItemRunRecord,
  item: WorkItemInventoryResult["items"][number],
  workspaceRoot: string,
  nextRunStartedAt: number,
  checkedAt: number,
): boolean {
  if (!path.isAbsolute(workspaceRoot) || run.workspacePath !== workspaceRoot) return false;
  const checkoutPath = run.repositories?.[0]?.checkoutPath;
  if (!checkoutPath || path.isAbsolute(checkoutPath) || checkoutPath.includes("\\") || checkoutPath.split("/").some(segment => segment === "." || segment === ".." || !segment)) return false;
  const repositoriesRoot = path.join(workspaceRoot, "repositories");
  const repository = path.resolve(workspaceRoot, checkoutPath);
  const relative = path.relative(repositoriesRoot, repository);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  const startedAt = Date.parse(run.startedAt);
  const runtimeStartedAt = Date.parse(record.startedAt);
  return Number.isFinite(startedAt)
    && record.backlogId === String(item.issueNumber)
    && matchesProviderRef(record.providerRef, item)
    && record.session === `afk-${item.id}`
    && record.workspace === repository
    && runtimeStartedAt >= startedAt && runtimeStartedAt < nextRunStartedAt
    && Date.parse(record.completedAt) <= checkedAt;
}

function matchesProviderRef(providerRef: string, item: WorkItemInventoryResult["items"][number]): boolean {
  if (providerRef === item.providerRef) return true;
  const project = item.project;
  return project.platform === "gitlab"
    && project.providerProjectId !== undefined
    && /^[1-9]\d*$/.test(project.providerProjectId)
    && item.id === item.providerRef
    && item.providerRef === `gitlab:${project.projectKey}#${item.issueNumber}`
    && providerRef === `gitlab:${project.providerProjectId}#${item.issueNumber}`;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createWorkItemRunHistoryService(deps: HistoryDeps) {
  const isPidAlive = deps.isPidAlive ?? pidAlive;
  const now = deps.now ?? (() => new Date());
  const runtimeArchiveDirectory = deps.runtimeArchiveDirectory ?? path.join(homedir(), ".afk", "runtime", "tasks", "archive");

  return {
    async merge(inventory: WorkItemInventoryResult): Promise<WorkItemInventoryResult> {
      let archivePromise: Promise<RuntimeTerminal[]> | undefined;
      const items = await Promise.all(inventory.items.map(async item => {
        const workspace = await deps.workspace.read(item.id);
        if (!workspace || workspace.cleanupStatus === "cleaned" || workspace.taskId !== item.id) return item;
        const checkedAt = now();
        let runs: WorkItemRunRecord[] = [];
        await deps.runStore.update(workspace.root, async stored => {
          let changed = false;
          runs = await Promise.all(stored.map(async (run): Promise<WorkItemRunRecord> => {
            if (run.status !== "starting" && run.status !== "running") return run;
            if (run.pid === undefined && (run.status !== "starting" || !Number.isFinite(Date.parse(run.startedAt)) || checkedAt.getTime() - Date.parse(run.startedAt) >= STARTING_GRACE_MS)) {
              changed = true;
            } else if (run.pid !== undefined && checkedAt.getTime() - Date.parse(run.startedAt) >= EXIT_EVENT_GRACE_MS && !isPidAlive(run.pid)) {
              changed = true;
            } else {
              return run;
            }
            archivePromise ??= readRuntimeArchive(runtimeArchiveDirectory);
            const archive = await archivePromise;
            const nextRunStartedAt = Math.min(...stored
              .filter(other => other.id !== run.id && Date.parse(other.startedAt) > Date.parse(run.startedAt))
              .map(other => Date.parse(other.startedAt)));
            const terminal = archive
              .filter(record => matchesRuntime(record, run, item, workspace.root, nextRunStartedAt, checkedAt.getTime()))
              .sort((left, right) => right.startedAt.localeCompare(left.startedAt))[0];
            if (terminal) {
              const { pid: _pid, error: _error, ...previous } = run;
              return {
                ...previous, status: terminal.status === "completed" ? "completed" : "failed",
                completedAt: terminal.completedAt,
                ...(terminal.status === "completed" ? {} : { error: terminal.errorSummary ?? `AFK 运行${terminal.status === "blocked" ? "已阻塞" : "失败"}` }),
              };
            }
            return { ...run, status: "failed", completedAt: checkedAt.toISOString(), error: "AFK 进程已退出，未收到运行终态" };
          }));
          return changed ? runs : undefined;
        });
        if (workspace.currentRunId && runs.some(run => run.id === workspace.currentRunId && (run.status === "failed" || run.status === "completed"))) {
          await deps.workspace.updateRun(item.id, undefined, workspace.currentRunId);
        }
        const merged = new Map((item.runs ?? []).map(run => [run.id, run]));
        for (const run of runs) merged.set(run.id, run);
        return { ...item, runs: [...merged.values()].sort((left, right) => right.startedAt.localeCompare(left.startedAt)) };
      }));
      return { ...inventory, items };
    },
  };
}
