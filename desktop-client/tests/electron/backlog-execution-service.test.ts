import { describe, expect, it, vi } from "vitest";
import { createBacklogExecutionService } from "../../electron/services/backlog-execution-service";
import { formatWorkItemId, type BacklogItem as ProviderBacklogItem, type ReworkRecord } from "@afk/application";
import type { BacklogRuntimeSummary, BacklogRunSummary } from "../../shared/backlog-contract";

describe("backlog execution service", () => {
  function createPorts(item: ProviderBacklogItem) {
    const backlog = {
      get: vi.fn(async () => item),
      list: vi.fn(async () => [item]),
      create: vi.fn(async () => item),
      addTag: vi.fn(async () => undefined),
      removeTag: vi.fn(async () => undefined),
      initialize: vi.fn(async () => undefined),
      transition: vi.fn(async () => undefined),
      setExecutionMode: vi.fn(async () => undefined),
      createRework: vi.fn(async (): Promise<ReworkRecord> => ({ version: 1, id: "r1", attempt: 1, status: "open", source: "operator", summary: "rework", failedCriteria: [], requiredChecks: [], createdAt: "2026-09-17T00:00:00.000Z" })),
      getActiveRework: vi.fn(async () => undefined),
      resolveRework: vi.fn(async () => undefined),
    };
    const change = { id: "7", state: "open" as const, sourceBranch: `${item.branchName}-qa`, targetBranch: "main", mergeable: true };
    const changes = {
      findForBacklog: vi.fn(async () => change),
      merge: vi.fn(async () => undefined),
      get: vi.fn(async () => ({ ...change, state: "merged" as const })),
    };
    return { backlog, changes };
  }

  function createMemoryStore() {
    const values = new Map<string, BacklogRunSummary[]>();
    return {
      load: vi.fn(async (workspace: string) => values.get(workspace) ?? []),
      save: vi.fn(async (workspace: string, runs: BacklogRunSummary[]) => { values.set(workspace, runs); }),
    };
  }

  function backlog(overrides: Partial<ProviderBacklogItem> = {}): ProviderBacklogItem {
    return {
      id: "42",
      title: "工作项",
      dependsOn: [],
      state: "ready",
      executionMode: "afk",
      tags: [],
      branchName: "afk/backlog-42",
      providerRef: "stub:42",
      ...overrides,
    };
  }

  function summary(item: ProviderBacklogItem, extra: Partial<Omit<BacklogRuntimeSummary, "backlog" | "backlogId">> = {}): Omit<BacklogRuntimeSummary, "backlog"> & { backlog: ProviderBacklogItem } {
    return { backlogId: item.id, ...extra, backlog: item };
  }

  it("marks the run failed and interrupts the backlog when the user stops it", async () => {
    const store = createMemoryStore();
    await store.save("/repo", [{ id: "desktop-42", backlogId: "42", status: "running", startedAt: "2026-09-17T00:00:00.000Z" }]);
    const active = backlog({ state: "in_progress" });
    const ports = createPorts(active);
    const service = createBacklogExecutionService({
      resolveWorkspace: (workspace) => workspace,
      providers: async () => ports,
      targetBranch: async () => "main",
      getSummary: vi.fn().mockResolvedValueOnce(summary(active)).mockResolvedValueOnce(summary(backlog({ state: "blocked", executionMode: "hitl" }))),
      store,
    });

    await service.stop("/repo", "42");

    expect((await store.load("/repo"))[0]).toMatchObject({ status: "failed", error: "用户从桌面停止执行" });
    expect(ports.backlog.transition).toHaveBeenCalledWith("42", "blocked", { reason: "用户从桌面停止执行" });
  });

  it("stops the run's agent when the user stops it", async () => {
    // Handing the backlog to an operator is not the same as stopping the
    // agent: the run lives in another process, and an agent that keeps
    // working keeps spending the budget the stop was meant to end.
    const store = createMemoryStore();
    await store.save("/repo", [{ id: "desktop-42", backlogId: "42", status: "running", startedAt: "2026-09-17T00:00:00.000Z" }]);
    const active = backlog({ state: "in_progress" });
    const ports = createPorts(active);
    const stopRun = vi.fn(async () => true);
    const service = createBacklogExecutionService({
      resolveWorkspace: (workspace) => workspace,
      providers: async () => ports,
      targetBranch: async () => "main",
      stopRun,
      getSummary: vi.fn()
        .mockResolvedValueOnce(summary(active, { runtime: { runId: "run-42", status: "running", phase: "implementing", heartbeatAt: "2026-09-17T00:00:00.000Z" } }))
        .mockResolvedValueOnce(summary(backlog({ state: "blocked", executionMode: "hitl" }))),
      store,
    });

    await service.stop("/repo", "42");

    expect(stopRun).toHaveBeenCalledWith("run-42");
  });

  it("confirms a root merge through the intent command", async () => {
    const mergeReady = backlog({ state: "merge_ready", executionMode: "hitl" });
    const done = summary(backlog({ state: "done", executionMode: "hitl" }));
    const ports = createPorts(mergeReady);
    const service = createBacklogExecutionService({
      resolveWorkspace: (workspace) => workspace,
      providers: async () => ports,
      targetBranch: async () => "main",
      getSummary: vi.fn().mockResolvedValueOnce(summary(mergeReady)).mockResolvedValueOnce(done),
      store: createMemoryStore(),
    });

    await expect(service.confirmMerge("/repo", "42")).resolves.toEqual(done);
    expect(ports.changes.merge).toHaveBeenCalledWith("7");
    expect(ports.backlog.transition).toHaveBeenCalledWith("42", "done", { changeId: "7" });
  });

  it("interrupts a stale runtime when recovering", async () => {
    const stale = summary(backlog({ state: "verification", executionMode: "afk" }), {
      activeRun: { id: "desktop-42", backlogId: "42", status: "failed", startedAt: "2026-09-17T00:00:00.000Z" },
      runtime: { runId: "run-42", status: "stale", phase: "verifying", heartbeatAt: "2026-09-17T00:00:00.000Z" },
    });
    const blocked = summary(backlog({ state: "blocked", executionMode: "hitl" }));
    const ports = createPorts(stale.backlog);
    const getSummary = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValueOnce(blocked);
    const service = createBacklogExecutionService({
      resolveWorkspace: (workspace) => workspace,
      providers: async () => ports,
      targetBranch: async () => "main",
      getSummary,
      store: createMemoryStore(),
    });

    await expect(service.recover("/repo", "42")).resolves.toEqual(blocked);
    expect(ports.backlog.transition).toHaveBeenCalledWith("42", "blocked", { reason: "桌面恢复 stale 运行" });
  });
});
