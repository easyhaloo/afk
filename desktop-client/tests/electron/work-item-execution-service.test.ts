import { describe, expect, it, vi } from "vitest";
import type { GlobalWorkItem, ProviderProjectRef } from "../../shared/backlog-contract";
import { createWorkItemExecutionService } from "../../electron/services/work-item-execution-service";

type StoredRun = {
  id: string;
  status: "starting" | "running" | "completed" | "failed";
  startedAt: string;
  completedAt?: string;
  workflow?: string;
  workspacePath?: string;
  pid?: number;
  error?: string;
};

const apiProject: ProviderProjectRef = { platform: "github", projectKey: "acme/api", name: "api" };
const webProject: ProviderProjectRef = { platform: "gitlab", projectKey: "platform/web", name: "web" };

function item(overrides: Partial<GlobalWorkItem & { repositories: ProviderProjectRef[] }> = {}): GlobalWorkItem & { repositories?: ProviderProjectRef[] } {
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

describe("work item execution service", () => {
  it("allocates a workspace, spawns AFK, and persists a running record", async () => {
    const allocate = vi.fn(async () => ({ root: "/tmp/.loop-workspace/WI-2026-018" }));
    const updateRun = vi.fn(async () => undefined);
    const stored: StoredRun[] = [];
    const runStore = {
      load: vi.fn(async () => stored),
      save: vi.fn(async (_workspace: string, runs: StoredRun[]) => {
        stored.splice(0, stored.length, ...runs);
      }),
    };
    const child = { pid: 4321, once: vi.fn(() => child), unref: vi.fn() };
    const spawn = vi.fn(() => child);
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ id: "WI-2026-018", repositories: [apiProject, webProject] }),
      resolveAfk: async () => "/usr/local/bin/afk",
      workspace: { allocate, updateRun },
      runStore,
      spawn,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({ workItemId: "WI-2026-018", repositories: [apiProject, webProject], workflow: "standard-development", environment: "local" });

    expect(allocate).toHaveBeenCalledWith("WI-2026-018", [apiProject, webProject]);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      ["run", "--backlog-id", "WI-2026-018", "--template", "standard-development"],
      { cwd: "/tmp/.loop-workspace/WI-2026-018", detached: true, stdio: "ignore", env: expect.objectContaining({ PWD: "/tmp/.loop-workspace/WI-2026-018" }) },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(updateRun).toHaveBeenCalledWith("WI-2026-018", expect.any(String));
    expect(result.runId).toMatch(/^desktop-WI-2026-018-/);
    expect(result.workspace).toEqual({ root: "/tmp/.loop-workspace/WI-2026-018" });
    expect(stored).toEqual([expect.objectContaining({
      id: result.runId,
      status: "running",
      startedAt: "2026-09-21T08:00:00.000Z",
      workflow: "standard-development",
      workspacePath: "/tmp/.loop-workspace/WI-2026-018",
      pid: 4321,
    })]);
  });

  it("falls back to the imported issue project when no explicit repositories exist", async () => {
    const allocate = vi.fn(async () => ({ root: "/tmp/task" }));
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate },
      resolveAfk: async () => "/usr/local/bin/afk",
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(() => ({ pid: 1, once: vi.fn(() => undefined), unref: vi.fn() })),
    });

    const result = await service.start({ workItemId: "github:acme/api#42", repositories: [apiProject] });

    expect(allocate).toHaveBeenCalledWith("github:acme/api#42", [apiProject]);
    expect(result.runId).toBeTruthy();
  });

  it("rejects unmanaged or non-runnable work items before allocating a directory", async () => {
    const allocate = vi.fn();
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item({ managed: false, executionEligible: false }),
      workspace: { allocate },
      resolveAfk: async () => "/usr/local/bin/afk",
      runStore: { load: async () => [], save: async () => undefined },
      spawn: vi.fn(),
    });

    await expect(service.start({ workItemId: "github:acme/api#42", repositories: [apiProject] })).rejects.toThrow("不可执行");
    expect(allocate).not.toHaveBeenCalled();
  });

  it("persists a terminal failure when the child process emits an error", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const stored: StoredRun[] = [];
    const child = {
      pid: 99,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; }),
      unref: vi.fn(),
    };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => ({ root: "/tmp/task" }) },
      resolveAfk: async () => "/usr/local/bin/afk",
      runStore: {
        load: async () => stored,
        save: async (_workspace, runs) => { stored.splice(0, stored.length, ...runs); },
      },
      spawn: () => child,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({ workItemId: "github:acme/api#42", repositories: [apiProject] });
    listeners.get("error")?.(new Error("spawn failed"));

    await vi.waitFor(() => expect(stored[0]).toMatchObject({ id: result.runId, status: "failed", error: "spawn failed" }));
  });

  it("persists a completed terminal state when the child exits successfully", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const stored: StoredRun[] = [];
    const child = {
      pid: 100,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => { listeners.set(event, listener); return child; }),
      unref: vi.fn(),
    };
    const service = createWorkItemExecutionService({
      getWorkItem: async () => item(),
      workspace: { allocate: async () => ({ root: "/tmp/task" }) },
      resolveAfk: async () => "/usr/local/bin/afk",
      runStore: {
        load: async () => stored,
        save: async (_workspace, runs) => { stored.splice(0, stored.length, ...runs); },
      },
      spawn: () => child,
      now: () => new Date("2026-09-21T08:00:00.000Z"),
    });

    const result = await service.start({ workItemId: "github:acme/api#42", repositories: [apiProject] });
    listeners.get("exit")?.(0);

    await vi.waitFor(() => expect(stored[0]).toMatchObject({ id: result.runId, status: "completed", completedAt: "2026-09-21T08:00:00.000Z" }));
  });
});
