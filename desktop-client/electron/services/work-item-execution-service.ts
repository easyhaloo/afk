import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type {
  GlobalWorkItem,
  ProviderProjectRef,
  WorkItemId,
  WorkItemRepositoryRef,
  WorkItemRunRepositorySelection,
  WorkItemRunStartInput,
  WorkItemRunStartResult,
  WorkItemRunRecord,
} from "../../shared/backlog-contract";
import {
  validateBaseBranch,
  validateRunRepositorySelection,
} from "../../shared/work-item-run-validation";
import {
  workItemExecutionManifestPath,
  type createWorkItemExecutionManifestStore,
} from "./work-item-execution-manifest-store";
import type { createWorkItemRunStore } from "./work-item-run-store";

type SpawnedProcess = Pick<ChildProcess, "pid" | "once" | "unref"> & Partial<Pick<ChildProcess, "kill">>;
type WorkItemSpawnOptions = { cwd: string; detached: boolean; stdio: "ignore"; env?: NodeJS.ProcessEnv };
type AllocatedWorkspace = {
  root: string;
  repositories: Array<{ project: ProviderProjectRef; path: string }>;
};
type Workspace = {
  allocate: (workItemId: WorkItemId, repositories: readonly ProviderProjectRef[]) => Promise<AllocatedWorkspace>;
  updateRun: (workItemId: WorkItemId, runId: string | undefined, expectedRunId?: string) => Promise<unknown>;
};

export type WorkItemExecutionServiceDeps = {
  getWorkItem: (workItemId: WorkItemId) => Promise<GlobalWorkItem>;
  resolveAfk: () => Promise<string>;
  workspace: Workspace;
  manifestStore: Pick<ReturnType<typeof createWorkItemExecutionManifestStore>, "save">;
  runStore: Pick<ReturnType<typeof createWorkItemRunStore>, "load" | "save"> & Partial<Pick<ReturnType<typeof createWorkItemRunStore>, "update">>;
  spawn?: (command: string, args: string[], options: WorkItemSpawnOptions) => SpawnedProcess;
  now?: () => Date;
  reportError?: (error: unknown) => void;
};

export function buildWorkItemRunArgs(input: WorkItemRunStartInput, manifestPath: string): string[] {
  const args = ["run", "--backlog-id", input.workItemId, "--execution-manifest", manifestPath];
  if (input.workflow) args.push("--template", input.workflow);
  return args;
}

function repositoryKey(repository: Pick<ProviderProjectRef, "platform" | "projectKey">): string {
  return `${repository.platform}:${repository.projectKey}`;
}

function authoritativeRepositories(
  selected: readonly WorkItemRunRepositorySelection[],
  associated: readonly (ProviderProjectRef | WorkItemRepositoryRef)[],
): Array<{ repository: ProviderProjectRef | WorkItemRepositoryRef; baseBranch: string }> {
  const associatedByKey = new Map(associated.map(repository => [repositoryKey(repository), repository]));
  return selected.map((selection) => {
    const repository = associatedByKey.get(repositoryKey(selection));
    if (!repository) throw new Error(`repository ${repositoryKey(selection)} is not associated with the work item`);
    if (
      selection.providerProjectId !== undefined
      && repository.providerProjectId !== undefined
      && selection.providerProjectId !== repository.providerProjectId
    ) {
      throw new Error(`repository ${repositoryKey(selection)} providerProjectId conflicts with the associated repository`);
    }
    return { repository, baseBranch: selection.baseBranch };
  });
}

function canonicalRepositories(
  workspace: AllocatedWorkspace,
  selected: readonly { repository: ProviderProjectRef | WorkItemRepositoryRef; baseBranch: string }[],
): WorkItemRunRepositorySelection[] {
  const allocatedByKey = new Map(workspace.repositories.map(repository => [repositoryKey(repository.project), repository]));
  const repositoriesRoot = path.resolve(workspace.root, "repositories");
  return selected.map(({ repository, baseBranch }) => {
    const allocated = allocatedByKey.get(repositoryKey(repository));
    if (!allocated) throw new Error(`workspace is missing repository ${repositoryKey(repository)}`);
    const relative = path.relative(repositoriesRoot, path.resolve(allocated.path));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`workspace repository ${repositoryKey(repository)} must be located under repositories/`);
    }
    const checkoutPath = `repositories/${relative.split(path.sep).join("/")}`;
    return {
      platform: repository.platform,
      projectKey: repository.projectKey,
      ...(repository.providerHost === undefined ? {} : { providerHost: repository.providerHost }),
      ...(repository.providerProjectId === undefined ? {} : { providerProjectId: repository.providerProjectId }),
      name: repository.name,
      checkoutPath,
      baseBranch,
      ...(!("role" in repository) || repository.role === undefined ? {} : { role: repository.role }),
    };
  });
}

export function createWorkItemExecutionService(deps: WorkItemExecutionServiceDeps) {
  const spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, args, options));
  const now = deps.now ?? (() => new Date());
  const reportError = deps.reportError ?? ((error: unknown) => console.error(error));
  let storeWrite = Promise.resolve();
  const taskStarts = new Map<WorkItemId, Promise<void>>();

  function report(error: unknown): void {
    try {
      reportError(error);
    } catch {
      return;
    }
  }

  function withStore<T>(action: () => Promise<T>): Promise<T> {
    const operation = storeWrite.then(action);
    storeWrite = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function persist(workspace: string, transform: (runs: WorkItemRunRecord[]) => WorkItemRunRecord[] | undefined): Promise<void> {
    if (deps.runStore.update) return deps.runStore.update(workspace, transform);
    return withStore(async () => {
      const next = transform(await deps.runStore.load(workspace));
      if (next) await deps.runStore.save(workspace, next);
    });
  }

  function update(workspace: string, run: WorkItemRunRecord): Promise<void> {
    return persist(workspace, stored => {
      const current = stored.find(item => item.id === run.id);
      if (current?.status === "completed" || current?.status === "failed") return undefined;
      return current
        ? stored.map(item => item.id === run.id ? run : item)
        : [...stored, run];
    });
  }

  function updateRunning(workspace: string, run: WorkItemRunRecord): Promise<void> {
    return persist(workspace, stored => {
      const current = stored.find(item => item.id === run.id);
      if (current && current.status !== "running") return undefined;
      return current
        ? stored.map(item => item.id === run.id ? run : item)
        : [...stored, run];
    });
  }

  async function startUnlocked(input: WorkItemRunStartInput): Promise<WorkItemRunStartResult> {
    const item = await deps.getWorkItem(input.workItemId);
    if (!item.managed || !item.executionEligible) throw new Error(`工作项 ${input.workItemId} 当前不可执行`);

    const associated = item.repositories === undefined ? [item.project] : item.repositories;
    const selected = validateRunRepositorySelection(input.repositories, associated);
    const authoritative = authoritativeRepositories(selected, associated);
    const workingBranch = validateBaseBranch(item.branchName, "branchName");

    const workspace = await deps.workspace.allocate(input.workItemId, authoritative.map(selection => selection.repository));
    if ((await deps.runStore.load(workspace.root)).some(run => run.status === "starting" || run.status === "running")) {
      throw new Error(`工作项 ${input.workItemId} 已有运行中的任务，请等待运行结束`);
    }
    const repositories = canonicalRepositories(workspace, authoritative);
    const afkPath = await deps.resolveAfk();
    if (!afkPath) throw new Error("afk CLI 未在 PATH 中发现");
    const manifestPath = workItemExecutionManifestPath(workspace.root);
    await deps.manifestStore.save(workspace.root, {
      schemaVersion: 1,
      workItemId: input.workItemId,
      providerBacklogId: String(item.issueNumber),
      tracker: {
        platform: item.project.platform,
        projectKey: item.project.projectKey,
        ...(item.project.providerHost ? { providerHost: item.project.providerHost } : {}),
        ...(item.project.providerProjectId ? { providerProjectId: item.project.providerProjectId } : {}),
      },
      workingBranch,
      repositories: repositories.map((repository, index) => ({
        ...repository,
        workingBranch,
        primary: index === 0,
      })),
    });

    const runId = `desktop-${input.workItemId}-${randomUUID()}`;
    const startedAt = now().toISOString();
    const starting: WorkItemRunRecord = {
      id: runId,
      status: "starting",
      startedAt,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      workingBranch,
      repositories,
      workspacePath: workspace.root,
    };
    await update(workspace.root, starting);
    try {
      await deps.workspace.updateRun(input.workItemId, runId);
    } catch (error) {
      const failed: WorkItemRunRecord = {
        ...starting,
        status: "failed",
        completedAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await update(workspace.root, failed).catch(report);
      await deps.workspace.updateRun(input.workItemId, undefined, runId).catch(report);
      throw error;
    }

    let child: SpawnedProcess;
    try {
      child = spawn(afkPath, buildWorkItemRunArgs(input, manifestPath), {
        cwd: workspace.root,
        detached: true,
        stdio: "ignore",
        env: { ...process.env, PWD: workspace.root },
      });
    } catch (error) {
      const failed: WorkItemRunRecord = {
        ...starting,
        status: "failed",
        completedAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await update(workspace.root, failed).catch(report);
      await deps.workspace.updateRun(input.workItemId, undefined, runId).catch(report);
      throw error;
    }

    const running: WorkItemRunRecord = {
      ...starting,
      status: "running",
      ...(typeof child.pid === "number" ? { pid: child.pid } : {}),
    };
    let runningPersisted = false;
    let terminalRecorded = false;
    let terminalCleanupStarted = false;
    let pendingTerminal: WorkItemRunRecord | undefined;
    const clearTerminalRun = async () => {
      if (terminalCleanupStarted) return;
      terminalCleanupStarted = true;
      await deps.workspace.updateRun(input.workItemId, undefined, runId).catch(report);
    };
    const persistTerminal = async (terminal: WorkItemRunRecord) => {
      await updateRunning(workspace.root, terminal).catch(report);
      await clearTerminalRun();
    };
    const recordTerminal = (terminal: WorkItemRunRecord) => {
      if (terminalRecorded) return;
      terminalRecorded = true;
      if (runningPersisted) void persistTerminal(terminal);
      else pendingTerminal = terminal;
    };
    child.once("error", (error: Error) => {
      recordTerminal({ ...running, status: "failed", completedAt: now().toISOString(), error: error.message });
    });
    child.once("exit", (code: number | null) => {
      recordTerminal({
        ...running,
        status: code === 0 ? "completed" : "failed",
        completedAt: now().toISOString(),
        ...(code === 0 ? {} : { error: `afk run exited with code ${code ?? "unknown"}` }),
      });
    });
    child.unref();
    try {
      await update(workspace.root, running);
    } catch (error) {
      terminalRecorded = true;
      if (child.kill) {
        try {
          child.kill();
        } catch (killError) {
          report(killError);
        }
      }
      const failed: WorkItemRunRecord = {
        ...running,
        status: "failed",
        completedAt: now().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await update(workspace.root, failed).catch(report);
      await deps.workspace.updateRun(input.workItemId, undefined, runId).catch(report);
      report(error);
      throw error;
    }
    runningPersisted = true;
    if (pendingTerminal) await persistTerminal(pendingTerminal);
    return { runId, workspace: { root: workspace.root } };
  }

  function start(input: WorkItemRunStartInput): Promise<WorkItemRunStartResult> {
    const previous = taskStarts.get(input.workItemId) ?? Promise.resolve();
    const result = previous.then(() => startUnlocked(input));
    const settled = result.then(() => undefined, () => undefined);
    taskStarts.set(input.workItemId, settled);
    void settled.then(() => {
      if (taskStarts.get(input.workItemId) === settled) taskStarts.delete(input.workItemId);
    });
    return result;
  }

  return { start };
}
