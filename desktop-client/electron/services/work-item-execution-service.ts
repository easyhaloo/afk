import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type {
  GlobalWorkItem,
  ProviderProjectRef,
  WorkItemId,
  WorkItemRunStartInput,
  WorkItemRunStartResult,
  WorkItemRunRecord,
} from "../../shared/backlog-contract";
import type { createExecutionWorkspaceService } from "./execution-workspace-service";
import type { createWorkItemRunStore } from "./work-item-run-store";

type ExecutableWorkItem = GlobalWorkItem & { repositories?: ProviderProjectRef[] };
type SpawnedProcess = Pick<ChildProcess, "pid" | "once" | "unref">;
type WorkItemSpawnOptions = { cwd: string; detached: boolean; stdio: "ignore"; env?: NodeJS.ProcessEnv };
type Workspace = Pick<ReturnType<typeof createExecutionWorkspaceService>, "allocate"> & Partial<Pick<ReturnType<typeof createExecutionWorkspaceService>, "updateRun">>;

export type WorkItemExecutionServiceDeps = {
  getWorkItem: (workItemId: WorkItemId) => Promise<ExecutableWorkItem>;
  resolveAfk: () => Promise<string>;
  workspace: Workspace;
  runStore: ReturnType<typeof createWorkItemRunStore>;
  spawn?: (command: string, args: string[], options: WorkItemSpawnOptions) => SpawnedProcess;
  now?: () => Date;
};

export function buildWorkItemRunArgs(input: WorkItemRunStartInput): string[] {
  const args = ["run", "--backlog-id", input.workItemId];
  if (input.workflow) args.push("--template", input.workflow);
  return args;
}

function projectKey(project: ProviderProjectRef): string {
  return `${project.platform}:${project.projectKey}`;
}

export function createWorkItemExecutionService(deps: WorkItemExecutionServiceDeps) {
  const spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
  const now = deps.now ?? (() => new Date());
  let storeWrite = Promise.resolve();

  function withStore<T>(action: () => Promise<T>): Promise<T> {
    const operation = storeWrite.then(action);
    storeWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async function update(workspace: string, run: WorkItemRunRecord): Promise<void> {
    await withStore(async () => {
      const stored = await deps.runStore.load(workspace);
      const next = stored.some(item => item.id === run.id)
        ? stored.map(item => item.id === run.id ? run : item)
        : [...stored, run];
      await deps.runStore.save(workspace, next);
    });
  }

  async function updateRunning(workspace: string, run: WorkItemRunRecord): Promise<void> {
    await withStore(async () => {
      const stored = await deps.runStore.load(workspace);
      const current = stored.find(item => item.id === run.id);
      if (current && current.status !== "running") return;
      const next = current
        ? stored.map(item => item.id === run.id ? run : item)
        : [...stored, run];
      await deps.runStore.save(workspace, next);
    });
  }

  async function start(input: WorkItemRunStartInput): Promise<WorkItemRunStartResult> {
    const item = await deps.getWorkItem(input.workItemId);
    if (!item.managed || !item.executionEligible) throw new Error(`工作项 ${input.workItemId} 当前不可执行`);

    const associated = item.repositories === undefined ? [item.project] : item.repositories;
    const allowed = new Set(associated.map(projectKey));
    const selected = input.repositories.filter((repository, index, repositories) =>
      repositories.findIndex(candidate => projectKey(candidate) === projectKey(repository)) === index);
    const invalid = selected.find(repository => !allowed.has(projectKey(repository)));
    if (invalid) throw new Error(`仓库 ${invalid.projectKey} 未关联到工作项 ${input.workItemId}`);

    const workspace = await deps.workspace.allocate(input.workItemId, selected);
    const afkPath = await deps.resolveAfk();
    if (!afkPath) throw new Error("afk CLI 未在 PATH 中发现");

    const runId = `desktop-${input.workItemId}-${randomUUID()}`;
    const startedAt = now().toISOString();
    const child = spawn(afkPath, buildWorkItemRunArgs(input), {
      cwd: workspace.root,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PWD: workspace.root },
    });
    const summary: WorkItemRunRecord = {
      id: runId,
      status: "running",
      startedAt,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      workspacePath: workspace.root,
      ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
    };
    let persisted = false;
    let terminalRecorded = false;
    let pendingTerminal: WorkItemRunRecord | undefined;
    const recordTerminal = (terminal: WorkItemRunRecord) => {
      if (terminalRecorded) return;
      terminalRecorded = true;
      if (persisted) void updateRunning(workspace.root, terminal);
      else pendingTerminal = terminal;
    };
    child.once("error", (error: Error) => {
      recordTerminal({ ...summary, status: "failed", completedAt: now().toISOString(), error: error.message });
    });
    child.once("exit", (code: number | null) => {
      recordTerminal({
        ...summary,
        status: code === 0 ? "completed" : "failed",
        completedAt: now().toISOString(),
        ...(code === 0 ? {} : { error: `afk run exited with code ${code ?? "unknown"}` }),
      });
    });
    child.unref();
    await update(workspace.root, summary);
    if (deps.workspace.updateRun) await deps.workspace.updateRun(input.workItemId, runId);
    persisted = true;
    if (pendingTerminal) await updateRunning(workspace.root, pendingTerminal);
    return { runId, workspace: { root: workspace.root } };
  }

  return { start };
}
