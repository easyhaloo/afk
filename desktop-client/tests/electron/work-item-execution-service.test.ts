import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  GlobalWorkItem,
  ProviderProjectRef,
  WorkItemRepositoryRef,
  WorkItemRunRecord,
  WorkItemRunRepositorySelection,
} from "../../shared/backlog-contract";
import { createWorkItemExecutionService } from "../../electron/services/work-item-execution-service";
import { buildForegroundAgentCommand } from "../../electron/services/work-item-execution-service";

const apiProject: WorkItemRepositoryRef = { platform: "github", projectKey: "acme/api", providerProjectId: "101", name: "api-service", role: "backend", baseBranch: "main" };
const webProject: WorkItemRepositoryRef = { platform: "gitlab", projectKey: "git.corp/platform/web", providerHost: "git.corp", providerProjectId: "202", name: "web-client", role: "frontend", baseBranch: "main" };
const apiSelection: WorkItemRunRepositorySelection = {
  ...apiProject,
  checkoutPath: "repositories/api",
  baseBranch: "main",
  role: "backend",
};
const webSelection: WorkItemRunRepositorySelection = {
  ...webProject,
  checkoutPath: "repositories/web",
  baseBranch: "release/2026.09",
  role: "frontend",
};

function allocatedWorkspace(root: string, projects: readonly ProviderProjectRef[], directoryNames?: readonly string[]) {
  return {
    root,
    repositories: projects.map((project, index) => ({
      project,
      path: path.join(root, "repositories", directoryNames?.[index] ?? project.name),
    })),
  };
}

function item(overrides: Partial<GlobalWorkItem> = {}): GlobalWorkItem {
  return {
    id: "github:acme/api#42",
    issueNumber: 42,
    project: apiProject,
    title: "Coordinate checkout changes",
    managed: true,
    executionEligible: true,
    state: "ready",
    executionMode: "afk",
    dependsOn: [],
    tags: [],
    branchName: "afk/42",
    providerRef: "github:acme/api#42",
    ...overrides,
  };
}

/** A promise whose settlement the test controls, standing in for a running execution. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createStoredRunStore(stored: WorkItemRunRecord[] = []) {
  return {
    stored,
    runStore: {
      load: vi.fn(async () => stored),
      save: vi.fn(async (_workspace: string, runs: WorkItemRunRecord[]) => {
        stored.splice(0, stored.length, ...runs);
      }),
    },
  };
}

describe("work item execution service", () => {
  it("opens a selected Agent in the selected terminal for HITL work", async () => {
    const openTerminalCommand = vi.fn(async () => "Terminal.app");
    const manifestStore = { save: vi.fn(async () => undefined) };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ executionMode: "hitl", webUrl: "https://github.com/acme/api/issues/42", description: "Implement the checkout change." }),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/hitl-task", [apiProject]), updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      resolveAgent: async id => ({ id, label: "Codex", command: "codex", executable: "/usr/local/bin/codex" }),
      openTerminalCommand,
      manifestStore,
      runStore: { load: async () => [], save: async () => undefined },
    });

    const result = await service.start({
      workItemId: "github:acme/api#42",
      repositories: [apiSelection],
      foreground: { agent: "codex", terminal: "terminal" },
    });

    expect(result.workspace).toEqual({ root: "/tmp/hitl-task" });
    expect(openTerminalCommand).toHaveBeenCalledWith(expect.stringContaining("请读取并实施工作项 github:acme/api#42"), "terminal");
    expect(openTerminalCommand).toHaveBeenCalledWith(expect.stringContaining("Implement the checkout change."), "terminal");
    expect(manifestStore.save).not.toHaveBeenCalled();
  });

  it("quotes the foreground Agent command and prompt as one shell command", () => {
    const command = buildForegroundAgentCommand(item({ title: "Issue's implementation" }), { id: "codex", label: "Codex", command: "codex", executable: "/usr/local/bin/codex" }, "/tmp/hitl task");
    expect(command).toContain("cd '/tmp/hitl task'");
    expect(command).toContain("'/usr/local/bin/codex'");
    expect(command).toContain("Issue'\\''s implementation");
  });

  it("runs Claude Code with permission checks skipped", () => {
    const command = buildForegroundAgentCommand(item(), { id: "claude", label: "Claude Code", command: "claude", executable: "/usr/local/bin/claude" }, "/tmp/task");
    expect(command).toContain("'/usr/local/bin/claude' '--dangerously-skip-permissions'");
    expect(command).toContain("GitHub 或 GitLab Issue");
  });

  it("uses atomic updates and leaves a reconciled terminal record unchanged when the execution finishes", async () => {
    const stored: WorkItemRunRecord[] = [];
    const execution = deferred<{ status: "done" }>();
    const runStore = {
      load: vi.fn(async () => [...stored]),
      save: vi.fn(async () => { throw new Error("non-atomic save"); }),
      update: vi.fn(async (_workspace: string, transform: (runs: WorkItemRunRecord[]) => WorkItemRunRecord[] | undefined | Promise<WorkItemRunRecord[] | undefined>) => {
        const next = await transform([...stored]);
        if (next) stored.splice(0, stored.length, ...next);
      }),
    };
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: () => execution.promise,
      manifestStore: { save: async () => undefined },
      runStore,
    });

    const { runId } = await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    expect(stored[0]?.status).toBe("running");
    stored[0] = { ...stored[0], status: "failed", error: "reconciled" };
    execution.resolve({ status: "done" });

    await vi.waitFor(() => expect(updateRun).toHaveBeenCalledWith("github:acme/api#42", undefined, runId));
    expect(stored[0]).toMatchObject({ status: "failed", error: "reconciled" });
    expect(runStore.update).toHaveBeenCalledTimes(3);
    expect(runStore.load).toHaveBeenCalledOnce();
    expect(runStore.save).not.toHaveBeenCalled();
  });

  it("rejects another run while one is active and preserves the current run", async () => {
    const { runStore } = createStoredRunStore();
    const execution = deferred<{ status: "done" }>();
    const execute = vi.fn(() => execution.promise);
    let currentRunId: string | undefined;
    const updateRun = vi.fn(async (_workItemId: string, runId: string | undefined, expectedRunId?: string) => {
      if (expectedRunId === undefined || currentRunId === expectedRunId) currentRunId = runId;
    });
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute,
      manifestStore: { save: async () => undefined },
      runStore,
    });

    const firstStart = service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    const secondStart = service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    const first = await firstStart;
    await expect(secondStart).rejects.toThrow("已有运行中的任务");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(currentRunId).toBe(first.runId);
    execution.resolve({ status: "done" });

    await vi.waitFor(() => expect(updateRun).toHaveBeenCalledWith("github:acme/api#42", undefined, first.runId));
    expect(currentRunId).toBeUndefined();
  });

  it("writes the ordered repository manifest, starts one in-process execution, and persists the selection", async () => {
    const workspaceRoot = "/tmp/.loop-workspace/WI-2026-018";
    const allocate = vi.fn(async () => allocatedWorkspace(workspaceRoot, [webProject, apiProject], ["frontend", "backend"]));
    const updateRun = vi.fn(async () => undefined);
    const manifestStore = { save: vi.fn(async () => undefined) };
    const { stored, runStore } = createStoredRunStore();
    const execute = vi.fn(async () => {
      expect(stored).toEqual([expect.objectContaining({ status: "starting" })]);
      expect(stored[0]).not.toHaveProperty("pid");
      expect(updateRun).toHaveBeenCalledWith("github:acme/api#42", stored[0]?.id);
      return { status: "done" as const };
    });
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ id: "github:acme/api#42", repositories: [apiProject, webProject], branchName: "afk/work-item-18" }),
      execute,
      workspace: { allocate, updateRun },
      manifestStore,
      runStore,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({
      workItemId: "github:acme/api#42",
      repositories: [
        { ...webSelection, providerProjectId: "202", name: "forged-web", checkoutPath: "forged/web", role: "forged-role" },
        { ...apiSelection, providerProjectId: "101", name: "forged-api", checkoutPath: "forged/api", role: "forged-role" },
      ],
      workflow: "standard-development",
      environment: "local",
    });

    const manifestPath = path.join(workspaceRoot, ".afk", "execution-manifest.json");
    expect(allocate).toHaveBeenCalledWith("github:acme/api#42", [webProject, apiProject]);
    expect(manifestStore.save).toHaveBeenCalledWith(workspaceRoot, {
      schemaVersion: 1,
      workItemId: "github:acme/api#42",
      providerBacklogId: "42",
      tracker: { platform: "github", projectKey: "acme/api", providerProjectId: "101" },
      workingBranch: "afk/work-item-18",
      repositories: [
        { ...webProject, checkoutPath: "repositories/frontend", baseBranch: webSelection.baseBranch, workingBranch: "afk/work-item-18", primary: true },
        { ...apiProject, checkoutPath: "repositories/backend", baseBranch: apiSelection.baseBranch, workingBranch: "afk/work-item-18", primary: false },
      ],
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({
      workItemId: "github:acme/api#42",
      manifestPath,
      template: "standard-development",
      executionId: result.runId,
    });
    expect(updateRun).toHaveBeenCalledWith("github:acme/api#42", expect.any(String));
    expect(result.runId).toMatch(/^desktop-[a-f\d-]{36}$/);
    expect(result.workspace).toEqual({ root: workspaceRoot });
    expect(stored).toEqual([expect.objectContaining({
      id: result.runId,
      status: "running",
      startedAt: "2026-09-21T08:00:00.000Z",
      workflow: "standard-development",
      workingBranch: "afk/work-item-18",
      repositories: [
        { ...webProject, checkoutPath: "repositories/frontend", baseBranch: webSelection.baseBranch },
        { ...apiProject, checkoutPath: "repositories/backend", baseBranch: apiSelection.baseBranch },
      ],
      workspacePath: workspaceRoot,
    })]);
  });

  it("keeps the work item's tracker and provider Issue ID when only a secondary repository is primary", async () => {
    const workspaceRoot = "/tmp/.loop-workspace/WI-2026-018";
    const allocate = vi.fn(async () => allocatedWorkspace(workspaceRoot, [webProject], ["frontend"]));
    const manifestStore = { save: vi.fn(async () => undefined) };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ id: "github:acme/api#731", issueNumber: 731, repositories: [apiProject, webProject] }),
      execute: async () => ({ status: "done" as const }),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      manifestStore,
      runStore: createStoredRunStore().runStore,
    });

    await service.start({ workItemId: "github:acme/api#731", repositories: [webSelection] });

    expect(allocate).toHaveBeenCalledWith("github:acme/api#731", [webProject]);
    expect(manifestStore.save).toHaveBeenCalledWith(workspaceRoot, expect.objectContaining({
      workItemId: "github:acme/api#731",
      providerBacklogId: "731",
      tracker: { platform: "github", projectKey: "acme/api", providerProjectId: "101" },
      repositories: [expect.objectContaining({
        platform: "gitlab", projectKey: "git.corp/platform/web", providerProjectId: "202", primary: true,
      })],
    }));
  });

  it("rejects a provider project ID that conflicts with the associated repository", async () => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ repositories: [apiProject] }),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({
      workItemId: "github:acme/api#42",
      repositories: [{ ...apiSelection, providerProjectId: "attacker-project" }],
    })).rejects.toThrow(/providerProjectId/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("rejects allocated repository paths outside the workspace repositories directory", async () => {
    const workspaceRoot = "/tmp/task";
    const manifestStore = { save: vi.fn() };
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ repositories: [apiProject] }),
      workspace: {
        allocate: async () => ({ root: workspaceRoot, repositories: [{ project: apiProject, path: path.join(workspaceRoot, "outside", "api") }] }),
        updateRun: vi.fn(async () => undefined),
      },
      execute: async () => ({ status: "done" as const }),
      manifestStore,
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toThrow(/repositories/i);
    expect(manifestStore.save).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes the workflow template to the execution runtime", async () => {
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun: vi.fn(async () => undefined) },
      execute,
      manifestStore: { save: async () => undefined },
      runStore: { load: async () => [], save: async () => undefined },
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection], workflow: "review" });

    expect(execute).toHaveBeenCalledWith({
      workItemId: "github:acme/api#42",
      manifestPath: "/tmp/task/.afk/execution-manifest.json",
      template: "review",
      executionId: expect.stringMatching(/^desktop-[a-f\d-]{36}$/),
    });
  });

  it("falls back to the imported issue project when no explicit repositories exist", async () => {
    const allocate = vi.fn(async () => allocatedWorkspace("/tmp/task", [apiProject]));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: async () => undefined },
      runStore: { load: async () => [], save: async () => undefined },
    });

    const result = await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });

    expect(allocate).toHaveBeenCalledWith("github:acme/api#42", [apiProject]);
    expect(result.runId).toBeTruthy();
  });

  it("rejects unmanaged or non-runnable work items before allocating a directory", async () => {
    const allocate = vi.fn();
    const manifestStore = { save: vi.fn() };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ managed: false, executionEligible: false }),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      manifestStore,
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toThrow("不可执行");
    expect(allocate).not.toHaveBeenCalled();
    expect(manifestStore.save).not.toHaveBeenCalled();
  });

  it("refuses a background run for a work item the execution runtime cannot name", async () => {
    // The runtime parses every work item id with the canonical identity
    // grammar before it runs one. A hand-minted id names no provider
    // issue, so the desktop says so at the click rather than writing a
    // manifest the runtime refuses and dying inside it.
    const allocate = vi.fn();
    const manifestStore = { save: vi.fn() };
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ id: "WI-2026-018" }),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute,
      manifestStore,
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({ workItemId: "WI-2026-018", repositories: [apiSelection] }))
      .rejects.toThrow(/Provider/);
    expect(allocate).not.toHaveBeenCalled();
    expect(manifestStore.save).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an empty repository selection before allocating or saving", async () => {
    const allocate = vi.fn();
    const manifestStore = { save: vi.fn() };
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      manifestStore,
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [] })).rejects.toThrow(/repositories/i);
    expect(allocate).not.toHaveBeenCalled();
    expect(manifestStore.save).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects repositories that are not associated with the work item", async () => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ repositories: [apiProject] }),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [webSelection] })).rejects.toThrow(/not associated|未关联/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("rejects duplicate repository selections instead of silently dropping them", async () => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection, apiSelection] })).rejects.toThrow(/duplicate repository/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("does not fall back to the issue project when repositories are explicitly empty", async () => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ repositories: [] }),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toThrow(/not associated|未关联/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each(["", "bad..branch"])('rejects an invalid work item branchName "%s" before allocating', async branchName => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ branchName }),
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toThrow(/branchName/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("does not start the execution, persist a run, or update currentRunId when manifest saving fails", async () => {
    const saveFailure = new Error("manifest write failed");
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const updateRun = vi.fn();
    const runStore = { load: vi.fn(async () => []), save: vi.fn(async () => undefined) };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: vi.fn(async () => { throw saveFailure; }) },
      runStore,
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toBe(saveFailure);
    expect(execute).not.toHaveBeenCalled();
    expect(runStore.load).toHaveBeenCalledOnce();
    expect(runStore.save).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("does not start the execution when the initial starting record cannot be persisted", async () => {
    const initialSaveFailure = new Error("starting record write failed");
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const updateRun = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: async () => undefined },
      runStore: { load: async () => [], save: vi.fn(async () => { throw initialSaveFailure; }) },
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toBe(initialSaveFailure);
    expect(updateRun).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not start the execution when currentRunId cannot be persisted", async () => {
    const updateFailure = new Error("workspace update failed");
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const updateRun = vi.fn()
      .mockRejectedValueOnce(updateFailure)
      .mockResolvedValueOnce(undefined);
    const { stored, runStore } = createStoredRunStore();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: async () => undefined },
      runStore,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toBe(updateFailure);
    expect(stored).toEqual([expect.objectContaining({
      status: "failed",
      completedAt: "2026-09-21T08:00:00.000Z",
      error: "workspace update failed",
    })]);
    expect(stored[0]).not.toHaveProperty("pid");
    expect(updateRun).toHaveBeenNthCalledWith(1, "github:acme/api#42", expect.any(String));
    expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
    expect(updateRun).toHaveBeenCalledTimes(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("records a failed terminal state and clears currentRunId when the execution rejects", async () => {
    const executionFailure = new Error("execution failed");
    const updateRun = vi.fn(async () => undefined);
    const { stored, runStore } = createStoredRunStore();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => { throw executionFailure; },
      manifestStore: { save: async () => undefined },
      runStore,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });

    await vi.waitFor(() => {
      expect(stored).toEqual([expect.objectContaining({ status: "failed", error: "execution failed", completedAt: "2026-09-21T08:00:00.000Z" })]);
    });
    expect(updateRun).toHaveBeenNthCalledWith(1, "github:acme/api#42", expect.any(String));
    expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
  });

  it("records failure and never starts the execution when the running record cannot be persisted", async () => {
    const runningSaveFailure = new Error("running record write failed");
    const reportError = vi.fn();
    const updateRun = vi.fn(async () => undefined);
    const stored: WorkItemRunRecord[] = [];
    let saveCount = 0;
    const runStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (_workspace: string, runs: WorkItemRunRecord[]) => {
        saveCount += 1;
        if (saveCount === 2) throw runningSaveFailure;
        stored.splice(0, stored.length, ...runs);
      }),
    };
    const execute = vi.fn(async () => ({ status: "done" as const }));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute,
      manifestStore: { save: async () => undefined },
      runStore,
      reportError,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toBe(runningSaveFailure);
    expect(execute).not.toHaveBeenCalled();
    expect(stored).toEqual([expect.objectContaining({ status: "failed", error: "running record write failed" })]);
    expect(updateRun).toHaveBeenLastCalledWith("github:acme/api#42", undefined, expect.any(String));
    expect(reportError).toHaveBeenCalledWith(runningSaveFailure);
  });

  it("reports asynchronous terminal persistence failures without an unhandled rejection", async () => {
    const terminalSaveFailure = new Error("terminal record write failed");
    const cleanupFailure = new Error("terminal cleanup failed");
    const reportError = vi.fn();
    const updateRun = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(cleanupFailure);
    let saveCount = 0;
    const runStore = {
      load: vi.fn(async () => []),
      save: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 3) throw terminalSaveFailure;
      }),
    };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => { throw new Error("execution failed"); },
      manifestStore: { save: async () => undefined },
      runStore,
      reportError,
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });

    await vi.waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(terminalSaveFailure);
      expect(reportError).toHaveBeenCalledWith(cleanupFailure);
    });
    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("persists a failure that arrives after the running record was saved", async () => {
    const stored: WorkItemRunRecord[] = [];
    const runStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (_workspace: string, runs: WorkItemRunRecord[]) => {
        stored.splice(0, stored.length, ...runs);
      }),
    };
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => { throw new Error("early execution failure"); },
      manifestStore: { save: async () => undefined },
      runStore,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });

    await vi.waitFor(() => {
      expect(stored).toEqual([expect.objectContaining({ status: "failed", error: "early execution failure" })]);
    });
    expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("persists a terminal failure with repository context when the execution rejects", async () => {
    const { stored, runStore } = createStoredRunStore();
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => { throw new Error("execution failed"); },
      manifestStore: { save: async () => undefined },
      runStore,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });

    await vi.waitFor(() => {
      expect(stored[0]).toMatchObject({
        id: result.runId,
        status: "failed",
        error: "execution failed",
        workingBranch: "afk/42",
        repositories: [{ ...apiProject, checkoutPath: "repositories/api-service", baseBranch: apiSelection.baseBranch }],
      });
      expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
    });
    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("persists a completed terminal state with repository context when the execution succeeds", async () => {
    const { stored, runStore } = createStoredRunStore();
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => ({ status: "done" as const }),
      manifestStore: { save: async () => undefined },
      runStore,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });

    await vi.waitFor(() => {
      expect(stored[0]).toMatchObject({
        id: result.runId,
        status: "completed",
        completedAt: "2026-09-21T08:00:00.000Z",
        workingBranch: "afk/42",
        repositories: [{ ...apiProject, checkoutPath: "repositories/api-service", baseBranch: apiSelection.baseBranch }],
      });
      expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
    });
    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("persists and clears currentRunId when the execution stops without a merge", async () => {
    const { stored, runStore } = createStoredRunStore();
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      execute: async () => ({ status: "rework" as const }),
      manifestStore: { save: async () => undefined },
      runStore,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });

    await vi.waitFor(() => {
      expect(stored[0]).toMatchObject({ status: "failed", error: "work item execution stopped: rework" });
      expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
    });
    expect(updateRun).toHaveBeenCalledTimes(2);
  });
});
