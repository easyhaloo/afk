import { randomUUID } from "node:crypto";
import { isCanonicalWorkItemId } from "@afk/application";
import { quoteShellArgument } from "@afk/infrastructure";
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
  WorkItemAgentId,
} from "../../shared/backlog-contract.js";
import type { SshExternalTerminalId } from "../../shared/ssh-contract.js";
import {
  validateBaseBranch,
  validateRunRepositorySelection,
} from "../../shared/work-item-run-validation.js";
import {
  workItemExecutionManifestPath,
  type createWorkItemExecutionManifestStore,
} from "./work-item-execution-manifest-store.js";
import type { createWorkItemRunStore } from "./work-item-run-store.js";

type AllocatedWorkspace = {
  root: string;
  repositories: Array<{ project: ProviderProjectRef; path: string }>;
};
type Workspace = {
  allocate: (workItemId: WorkItemId, repositories: readonly ProviderProjectRef[]) => Promise<AllocatedWorkspace>;
  updateRun: (workItemId: WorkItemId, runId: string | undefined, expectedRunId?: string) => Promise<unknown>;
};
type ForegroundAgent = { id: WorkItemAgentId; label: string; command: string; executable: string };

/** The outcome of one work item execution, as reported by the execution runtime. */
export type WorkItemExecutionOutcome = {
  status: "merge_ready" | "done" | "rework" | "blocked" | "not_claimed";
  changeUrl?: string;
};

export type WorkItemExecutionServiceDeps = {
  getWorkItem: (workItemId: WorkItemId) => Promise<GlobalWorkItem>;
  /**
   * Run one work item execution in process. The desktop and the CLI call the
   * same execution runtime, so a work item runs through the same code no
   * matter which entry point asked for it.
   */
  execute: (input: {
    workItemId: string;
    manifestPath: string;
    template?: string;
    executionId: string;
  }) => Promise<WorkItemExecutionOutcome>;
  resolveAgent?: (id: WorkItemAgentId) => Promise<ForegroundAgent | undefined>;
  openTerminalCommand?: (command: string, terminal: SshExternalTerminalId) => Promise<string>;
  workspace: Workspace;
  manifestStore: Pick<ReturnType<typeof createWorkItemExecutionManifestStore>, "save">;
  runStore: Pick<ReturnType<typeof createWorkItemRunStore>, "load" | "save"> & Partial<Pick<ReturnType<typeof createWorkItemRunStore>, "update">>;
  now?: () => Date;
  reportError?: (error: unknown) => void;
};


export function buildForegroundAgentCommand(item: GlobalWorkItem, agent: ForegroundAgent, workspaceRoot: string): string {
  const issueReference = item.webUrl ?? item.providerRef;
  const prompt = [
    `请读取并实施工作项 ${item.id}。`,
    `标题：${item.title}`,
    `对应 Issue：${issueReference}`,
    item.description?.trim() ? `工作项内容：\n${item.description.trim()}` : "请先读取对应 Issue 或工作项的完整内容。",
    "请在当前工作区完成实现，遵循仓库中的 AGENTS.md/项目约束，运行相关检查，并在完成后汇报改动和验证结果。",
    "任务完成后，请在对应的 GitHub 或 GitLab Issue 上附上一条进度评论，说明完成内容、验证结果和后续事项。",
  ].join("\n\n");
  const args = agent.id === "claude" ? ["--dangerously-skip-permissions", prompt] : [prompt];
  return `cd ${quoteShellArgument(workspaceRoot)} && ${[agent.executable || agent.command, ...args].map(quoteShellArgument).join(" ")}`;
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
    const foregroundAgent = input.foreground
      ? await deps.resolveAgent?.(input.foreground.agent)
      : undefined;
    if (input.foreground && (!foregroundAgent || !deps.openTerminalCommand)) throw new Error("前台执行能力不可用，请检查 Agent 和终端配置");

    // The execution runtime names the work item with the canonical identity
    // grammar before it runs one, so a work item without a provider-qualified
    // id has no run behind it. A foreground run hands the work item to an
    // agent in a terminal and does not go through the runtime, so it is not
    // held to that.
    if (!input.foreground && !isCanonicalWorkItemId(input.workItemId)) {
      throw new Error(`工作项 ${input.workItemId} 不是 Provider 关联的工作项，无法执行`);
    }

    const associated = item.repositories === undefined ? [item.project] : item.repositories;
    const selected = validateRunRepositorySelection(input.repositories, associated);
    const authoritative = authoritativeRepositories(selected, associated);
    const workingBranch = validateBaseBranch(item.branchName, "branchName");

    const workspace = await deps.workspace.allocate(input.workItemId, authoritative.map(selection => selection.repository));
    if ((await deps.runStore.load(workspace.root)).some(run => run.status === "starting" || run.status === "running")) {
      throw new Error(`工作项 ${input.workItemId} 已有运行中的任务，请等待运行结束`);
    }
    const repositories = canonicalRepositories(workspace, authoritative);
    if (input.foreground && foregroundAgent) {
      await deps.openTerminalCommand!(buildForegroundAgentCommand(item, foregroundAgent, workspace.root), input.foreground.terminal);
      return { runId: `desktop-${randomUUID()}`, workspace: { root: workspace.root } };
    }
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

    const runId = `desktop-${randomUUID()}`;
    const startedAt = now().toISOString();
    const starting: WorkItemRunRecord = {
      id: runId,
      status: "starting",
      startedAt,
      ...(input.workflow ? { workflow: input.workflow } : {}),
      workingBranch,
      repositories,
      workspacePath: workspace.root,
      // The process that runs the work item. The desktop runs it in its
      // own process, so this is the desktop's own pid - and it is what
      // the run history judges liveness by. A record without one reads
      // as "the process exited" while the work is still going.
      pid: process.pid,
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

    const running: WorkItemRunRecord = {
      ...starting,
      status: "running",
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
    try {
      await update(workspace.root, running);
    } catch (error) {
      terminalRecorded = true;
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
    // The execution runs in the background of the main process: the call
    // returns as soon as the run is recorded, and the outcome is persisted
    // when the execution settles.
    void deps.execute({
      workItemId: input.workItemId,
      manifestPath,
      ...(input.workflow ? { template: input.workflow } : {}),
      executionId: runId,
    }).then(
      outcome => {
        const succeeded = outcome.status === "merge_ready" || outcome.status === "done";
        recordTerminal({
          ...running,
          status: succeeded ? "completed" : "failed",
          completedAt: now().toISOString(),
          ...(succeeded ? {} : { error: `work item execution stopped: ${outcome.status}` }),
        });
      },
      (error: unknown) => {
        recordTerminal({
          ...running,
          status: "failed",
          completedAt: now().toISOString(),
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
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
