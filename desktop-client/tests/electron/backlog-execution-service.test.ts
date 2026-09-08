import { describe, expect, it, vi } from "vitest";
import {
  buildBacklogRunArgs,
  createBacklogExecutionService,
} from "../../electron/services/backlog-execution-service";
import type { BacklogRunSummary } from "../../shared/backlog-contract";

describe("backlog execution service", () => {
  function createMemoryStore() {
    const values = new Map<string, BacklogRunSummary[]>();
    return {
      load: vi.fn(async (workspace: string) => values.get(workspace) ?? []),
      save: vi.fn(async (workspace: string, runs: BacklogRunSummary[]) => { values.set(workspace, runs); }),
    };
  }

  it("builds a single-backlog command without shell interpolation", () => {
    expect(buildBacklogRunArgs({ backlogId: "42", template: "feature-delivery" })).toEqual([
      "run",
      "--backlog-id",
      "42",
      "--template",
      "feature-delivery",
    ]);
  });

  it("starts one run and returns a desktop run handle", async () => {
    const child = {
      pid: process.pid,
      once: vi.fn().mockReturnThis(),
      unref: vi.fn(),
    };
    const spawn = vi.fn(() => child);
    const store = createMemoryStore();
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: (workspace) => workspace,
      getBacklog: async () => ({ id: "42", title: "工作项", dependsOn: [], state: "ready", executionMode: "afk", tags: [], branchName: "afk/backlog-42", providerRef: "stub:42" }),
      store,
      spawn,
      now: () => new Date("2026-09-08T10:00:00.000Z"),
    });

    const result = await service.start("/repo", { backlogId: "42", template: "feature-delivery" });

    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      ["run", "--backlog-id", "42", "--template", "feature-delivery"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(child.unref).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      backlogId: "42",
      status: "running",
      startedAt: "2026-09-08T10:00:00.000Z",
      pid: process.pid,
      template: "feature-delivery",
    });
    expect(await service.list("/repo", "42")).toEqual([result]);
  });

  it("rejects non-ready items before resolving the CLI", async () => {
    const spawn = vi.fn();
    const store = createMemoryStore();
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: (workspace) => workspace,
      getBacklog: async () => ({ id: "42", title: "工作项", dependsOn: [], state: "in_progress", executionMode: "afk", tags: [], branchName: "afk/backlog-42", providerRef: "stub:42" }),
      store,
      spawn,
    });

    await expect(service.start("/repo", { backlogId: "42" })).rejects.toThrow("只有 ready 项可以启动");
    expect(spawn).not.toHaveBeenCalled();
  });
});
