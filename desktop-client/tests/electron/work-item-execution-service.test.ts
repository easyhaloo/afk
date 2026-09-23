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

const apiProject: WorkItemRepositoryRef = { platform: "github", projectKey: "acme/api", providerProjectId: "101", name: "api-service", role: "backend" };
const webProject: WorkItemRepositoryRef = { platform: "gitlab", projectKey: "git.corp/platform/web", providerHost: "git.corp", providerProjectId: "202", name: "web-client", role: "frontend" };
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
  it("uses atomic updates and leaves a reconciled terminal record unchanged on child exit", async () => {
    const stored: WorkItemRunRecord[] = [];
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const runStore = {
      load: vi.fn(async () => [...stored]),
      save: vi.fn(async () => { throw new Error("non-atomic save"); }),
      update: vi.fn(async (_workspace: string, transform: (runs: WorkItemRunRecord[]) => WorkItemRunRecord[] | undefined) => {
        const next = transform([...stored]);
        if (next) stored.splice(0, stored.length, ...next);
      }),
    };
    const child = {
      pid: 101,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; }),
      unref: vi.fn(),
    };
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: () => child,
    });

    const { runId } = await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    expect(stored[0]?.status).toBe("running");
    stored[0] = { ...stored[0], status: "failed", error: "reconciled" };
    listeners.get("exit")?.(0);

    await vi.waitFor(() => expect(updateRun).toHaveBeenCalledWith("github:acme/api#42", undefined, runId));
    expect(stored[0]).toMatchObject({ status: "failed", error: "reconciled" });
    expect(runStore.update).toHaveBeenCalledTimes(3);
    expect(runStore.load).toHaveBeenCalledOnce();
    expect(runStore.save).not.toHaveBeenCalled();
  });

  it("rejects another run while one is active and preserves the current run", async () => {
    const { runStore } = createStoredRunStore();
    const listeners: Array<Map<string, (...args: unknown[]) => void>> = [];
    let currentRunId: string | undefined;
    const updateRun = vi.fn(async (_workItemId: string, runId: string | undefined, expectedRunId?: string) => {
      if (expectedRunId === undefined || currentRunId === expectedRunId) currentRunId = runId;
    });
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: () => {
        const callbacks = new Map<string, (...args: unknown[]) => void>();
        listeners.push(callbacks);
        const child = {
          pid: listeners.length,
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { callbacks.set(event, listener); return child; }),
          unref: vi.fn(),
        };
        return child;
      },
    });

    const firstStart = service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    const secondStart = service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    const first = await firstStart;
    await expect(secondStart).rejects.toThrow("已有运行中的任务");
    expect(listeners).toHaveLength(1);
    expect(currentRunId).toBe(first.runId);
    listeners[0]?.get("exit")?.(0);

    await vi.waitFor(() => expect(updateRun).toHaveBeenCalledWith("github:acme/api#42", undefined, first.runId));
    expect(currentRunId).toBeUndefined();
  });

  it("writes the ordered repository manifest, spawns one AFK process, and persists the selection", async () => {
    const workspaceRoot = "/tmp/.loop-workspace/WI-2026-018";
    const allocate = vi.fn(async () => allocatedWorkspace(workspaceRoot, [webProject, apiProject], ["frontend", "backend"]));
    const updateRun = vi.fn(async () => undefined);
    const manifestStore = { save: vi.fn(async () => undefined) };
    const { stored, runStore } = createStoredRunStore();
    const child = { pid: 4321, once: vi.fn(() => child), unref: vi.fn() };
    const spawn = vi.fn(() => {
      expect(stored).toEqual([expect.objectContaining({ status: "starting" })]);
      expect(stored[0]).not.toHaveProperty("pid");
      expect(updateRun).toHaveBeenCalledWith("WI-2026-018", stored[0]?.id);
      return child;
    });
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ id: "WI-2026-018", repositories: [apiProject, webProject], branchName: "afk/work-item-18" }),
      resolveAfk: async () => "/usr/local/bin/afk",
      workspace: { allocate, updateRun },
      manifestStore,
      runStore,
      spawn,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({
      workItemId: "WI-2026-018",
      repositories: [
        { ...webSelection, providerProjectId: "202", name: "forged-web", checkoutPath: "forged/web", role: "forged-role" },
        { ...apiSelection, providerProjectId: "101", name: "forged-api", checkoutPath: "forged/api", role: "forged-role" },
      ],
      workflow: "standard-development",
      environment: "local",
    });

    const manifestPath = path.join(workspaceRoot, ".afk", "execution-manifest.json");
    expect(allocate).toHaveBeenCalledWith("WI-2026-018", [webProject, apiProject]);
    expect(manifestStore.save).toHaveBeenCalledWith(workspaceRoot, {
      schemaVersion: 1,
      workItemId: "WI-2026-018",
      providerBacklogId: "42",
      tracker: { platform: "github", projectKey: "acme/api", providerProjectId: "101" },
      workingBranch: "afk/work-item-18",
      repositories: [
        { ...webProject, checkoutPath: "repositories/frontend", baseBranch: webSelection.baseBranch, workingBranch: "afk/work-item-18", primary: true },
        { ...apiProject, checkoutPath: "repositories/backend", baseBranch: apiSelection.baseBranch, workingBranch: "afk/work-item-18", primary: false },
      ],
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      [
        "run",
        "--backlog-id",
        "WI-2026-018",
        "--execution-manifest",
        manifestPath,
        "--template",
        "standard-development",
      ],
      { cwd: workspaceRoot, detached: true, stdio: "ignore", env: expect.objectContaining({ PWD: workspaceRoot }) },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(updateRun).toHaveBeenCalledWith("WI-2026-018", expect.any(String));
    expect(result.runId).toMatch(/^desktop-WI-2026-018-/);
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
      pid: 4321,
    })]);
  });

  it("keeps the work item's tracker and provider Issue ID when only a secondary repository is primary", async () => {
    const workspaceRoot = "/tmp/.loop-workspace/WI-2026-018";
    const allocate = vi.fn(async () => allocatedWorkspace(workspaceRoot, [webProject], ["frontend"]));
    const manifestStore = { save: vi.fn(async () => undefined) };
    const child = { pid: 4321, once: vi.fn(() => child), unref: vi.fn() };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ id: "WI-2026-018", issueNumber: 731, repositories: [apiProject, webProject] }),
      resolveAfk: async () => "/usr/local/bin/afk",
      workspace: { allocate, updateRun: vi.fn(async () => undefined) },
      manifestStore,
      runStore: createStoredRunStore().runStore,
      spawn: vi.fn(() => child),
    });

    await service.start({ workItemId: "WI-2026-018", repositories: [webSelection] });

    expect(allocate).toHaveBeenCalledWith("WI-2026-018", [webProject]);
    expect(manifestStore.save).toHaveBeenCalledWith(workspaceRoot, expect.objectContaining({
      workItemId: "WI-2026-018",
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
      workspace: { allocate, updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(),
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
    const spawn = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ repositories: [apiProject] }),
      workspace: {
        allocate: async () => ({ root: workspaceRoot, repositories: [{ project: apiProject, path: path.join(workspaceRoot, "outside", "api") }] }),
        updateRun: vi.fn(),
      },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore,
      runStore: { load: async () => [], save: async () => undefined },
      spawn,
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toThrow(/repositories/i);
    expect(manifestStore.save).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("places the workflow arguments after the execution manifest arguments", async () => {
    const spawn = vi.fn(() => ({ pid: 1, once: vi.fn(), unref: vi.fn() }));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore: { load: async () => [], save: async () => undefined },
      spawn,
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection], workflow: "review" });

    expect(spawn.mock.calls[0]?.[1]).toEqual([
      "run",
      "--backlog-id",
      "github:acme/api#42",
      "--execution-manifest",
      "/tmp/task/.afk/execution-manifest.json",
      "--template",
      "review",
    ]);
  });

  it("falls back to the imported issue project when no explicit repositories exist", async () => {
    const allocate = vi.fn(async () => allocatedWorkspace("/tmp/task", [apiProject]));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate, updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(() => ({ pid: 1, once: vi.fn(), unref: vi.fn() })),
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
      workspace: { allocate, updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore,
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toThrow("不可执行");
    expect(allocate).not.toHaveBeenCalled();
    expect(manifestStore.save).not.toHaveBeenCalled();
  });

  it("rejects an empty repository selection before allocating or saving", async () => {
    const allocate = vi.fn();
    const manifestStore = { save: vi.fn() };
    const spawn = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate, updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore,
      runStore: { load: async () => [], save: async () => undefined },
      spawn,
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [] })).rejects.toThrow(/repositories/i);
    expect(allocate).not.toHaveBeenCalled();
    expect(manifestStore.save).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects repositories that are not associated with the work item", async () => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ repositories: [apiProject] }),
      workspace: { allocate, updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [webSelection] })).rejects.toThrow(/not associated|未关联/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("rejects duplicate repository selections instead of silently dropping them", async () => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate, updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection, apiSelection] })).rejects.toThrow(/duplicate repository/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("does not fall back to the issue project when repositories are explicitly empty", async () => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ repositories: [] }),
      workspace: { allocate, updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toThrow(/not associated|未关联/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it.each(["", "bad..branch"])('rejects an invalid work item branchName "%s" before allocating', async branchName => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ branchName }),
      workspace: { allocate, updateRun: vi.fn() },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: vi.fn() },
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toThrow(/branchName/i);
    expect(allocate).not.toHaveBeenCalled();
  });

  it("does not spawn, persist a run, or update currentRunId when manifest saving fails", async () => {
    const saveFailure = new Error("manifest write failed");
    const spawn = vi.fn();
    const updateRun = vi.fn();
    const runStore = { load: vi.fn(async () => []), save: vi.fn(async () => undefined) };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: vi.fn(async () => { throw saveFailure; }) },
      runStore,
      spawn,
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toBe(saveFailure);
    expect(spawn).not.toHaveBeenCalled();
    expect(runStore.load).toHaveBeenCalledOnce();
    expect(runStore.save).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("does not spawn when the initial starting record cannot be persisted", async () => {
    const initialSaveFailure = new Error("starting record write failed");
    const spawn = vi.fn();
    const updateRun = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore: { load: async () => [], save: vi.fn(async () => { throw initialSaveFailure; }) },
      spawn,
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toBe(initialSaveFailure);
    expect(updateRun).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not spawn when currentRunId cannot be persisted", async () => {
    const updateFailure = new Error("workspace update failed");
    const spawn = vi.fn();
    const updateRun = vi.fn()
      .mockRejectedValueOnce(updateFailure)
      .mockResolvedValueOnce(undefined);
    const { stored, runStore } = createStoredRunStore();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn,
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
    expect(spawn).not.toHaveBeenCalled();
  });

  it("records a failed terminal state and clears currentRunId when spawn throws synchronously", async () => {
    const spawnFailure = new Error("spawn threw");
    const updateRun = vi.fn(async () => undefined);
    const { stored, runStore } = createStoredRunStore();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: vi.fn(() => { throw spawnFailure; }),
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toBe(spawnFailure);
    expect(stored).toEqual([expect.objectContaining({ status: "failed", error: "spawn threw", completedAt: "2026-09-21T08:00:00.000Z" })]);
    expect(updateRun).toHaveBeenNthCalledWith(1, "github:acme/api#42", expect.any(String));
    expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
  });

  it("kills the child and records failure when the running record cannot be persisted", async () => {
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
    const child = { pid: 321, once: vi.fn(() => child), unref: vi.fn(), kill: vi.fn(() => true) };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: () => child,
      reportError,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] })).rejects.toBe(runningSaveFailure);
    expect(child.kill).toHaveBeenCalledOnce();
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
    const listeners = new Map<string, (...args: unknown[]) => void>();
    let saveCount = 0;
    const runStore = {
      load: vi.fn(async () => []),
      save: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 3) throw terminalSaveFailure;
      }),
    };
    const child = {
      pid: 99,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; }),
      unref: vi.fn(),
    };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: () => child,
      reportError,
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    listeners.get("error")?.(new Error("child failed"));

    await vi.waitFor(() => {
      expect(reportError).toHaveBeenCalledWith(terminalSaveFailure);
      expect(reportError).toHaveBeenCalledWith(cleanupFailure);
    });
    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("persists an error that arrives before the running record save completes", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const stored: WorkItemRunRecord[] = [];
    let emitted = false;
    const runStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (_workspace: string, runs: WorkItemRunRecord[]) => {
        if (runs[0]?.status === "running" && !emitted) {
          emitted = true;
          listeners.get("error")?.(new Error("early child failure"));
        }
        stored.splice(0, stored.length, ...runs);
      }),
    };
    const child = {
      pid: 99,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; }),
      unref: vi.fn(),
    };
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: () => child,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });

    expect(stored).toEqual([expect.objectContaining({ status: "failed", error: "early child failure" })]);
    expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("persists a terminal failure with repository context when the child process emits an error", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const { stored, runStore } = createStoredRunStore();
    const child = {
      pid: 99,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; }),
      unref: vi.fn(),
    };
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: () => child,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    listeners.get("error")?.(new Error("spawn failed"));

    await vi.waitFor(() => {
      expect(stored[0]).toMatchObject({
        id: result.runId,
        status: "failed",
        error: "spawn failed",
        workingBranch: "afk/42",
        repositories: [{ ...apiProject, checkoutPath: "repositories/api-service", baseBranch: apiSelection.baseBranch }],
      });
      expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
    });
    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("persists a completed terminal state with repository context when the child exits successfully", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const { stored, runStore } = createStoredRunStore();
    const child = {
      pid: 100,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; }),
      unref: vi.fn(),
    };
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: () => child,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    listeners.get("exit")?.(0);

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

  it("persists and clears currentRunId when the child exits unsuccessfully", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const { stored, runStore } = createStoredRunStore();
    const updateRun = vi.fn(async () => undefined);
    const child = {
      pid: 101,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; }),
      unref: vi.fn(),
    };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => allocatedWorkspace("/tmp/task", [apiProject]), updateRun },
      resolveAfk: async () => "/usr/local/bin/afk",
      manifestStore: { save: async () => undefined },
      runStore,
      spawn: () => child,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    await service.start({ workItemId: "github:acme/api#42", repositories: [apiSelection] });
    listeners.get("exit")?.(7);

    await vi.waitFor(() => {
      expect(stored[0]).toMatchObject({ status: "failed", error: "afk run exited with code 7" });
      expect(updateRun).toHaveBeenNthCalledWith(2, "github:acme/api#42", undefined, expect.any(String));
    });
    expect(updateRun).toHaveBeenCalledTimes(2);
  });
});
