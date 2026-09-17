import { describe, expect, it, vi } from "vitest";
import {
  buildBacklogRunArgs,
  createBacklogExecutionService,
} from "../../electron/services/backlog-execution-service";
import type { BacklogItem, BacklogRuntimeSummary, BacklogRunSummary } from "../../shared/backlog-contract";

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
      "loop",
      "--backlog-id",
      "42",
      "--max-iterations",
      "1",
      "--template",
      "feature-delivery",
    ]);
  });

  it("allows a rework backlog to start a new execution attempt", async () => {
    const values = new Map<string, BacklogRunSummary[]>();
    const store = {
      load: vi.fn(async (workspace: string) => values.get(workspace) ?? []),
      save: vi.fn(async (workspace: string, runs: BacklogRunSummary[]) => { values.set(workspace, runs); }),
    };
    const child = { pid: 1234, once: vi.fn(), unref: vi.fn() };
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: value => value,
      getBacklog: async () => ({ id: "42", title: "返工项", dependsOn: [], state: "rework", executionMode: "afk", tags: [], branchName: "afk/backlog-42", providerRef: "stub:42" }),
      store,
      spawn: vi.fn(() => child),
    });

    await expect(service.start("/repo", { backlogId: "42" })).resolves.toMatchObject({ backlogId: "42", status: "running" });
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
      ["loop", "--backlog-id", "42", "--max-iterations", "1", "--template", "feature-delivery"],
      expect.objectContaining({ cwd: "/repo", env: expect.objectContaining({ PWD: "/repo" }) }),
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

  it("invalidates the provider list cache when the loop exits", async () => {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const child = {
      pid: 1234,
      once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
        return child;
      }),
      unref: vi.fn(),
    };
    const invalidateBacklogList = vi.fn();
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: value => value,
      getBacklog: async () => backlog(),
      store: createMemoryStore(),
      spawn: vi.fn(() => child),
      invalidateBacklogList,
    });

    await service.start("/repo", { backlogId: "42" });
    expect(invalidateBacklogList).not.toHaveBeenCalled();
    listeners.get("exit")?.(0);
    expect(invalidateBacklogList).toHaveBeenCalledOnce();
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

    await expect(service.start("/repo", { backlogId: "42" })).rejects.toThrow("只有 ready/rework 项可以启动");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects HITL items even when their lifecycle state is ready", async () => {
    const spawn = vi.fn();
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: (workspace) => workspace,
      getBacklog: async () => ({ id: "42", title: "人工项", dependsOn: [], state: "ready", executionMode: "hitl", tags: [], branchName: "afk/backlog-42", providerRef: "stub:42" }),
      store: createMemoryStore(),
      spawn,
    });

    await expect(service.start("/repo", { backlogId: "42" })).rejects.toThrow("只有 AFK 自动项可以启动");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects an invalid selected template before spawning", async () => {
    const spawn = vi.fn();
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: (workspace) => workspace,
      getBacklog: async () => backlog(),
      validateTemplate: async () => false,
      store: createMemoryStore(),
      spawn,
    });

    await expect(service.start("/repo", { backlogId: "42", template: "missing-template" })).rejects.toThrow("not found or invalid");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("stops the local loop, escalates to SIGKILL, then interrupts an active backlog", async () => {
    const store = createMemoryStore();
    await store.save("/repo", [{ id: "desktop-42", backlogId: "42", status: "running", startedAt: "2026-09-17T00:00:00.000Z", pid: 1234 }]);
    const active = backlog({ state: "in_progress", executionMode: "afk" });
    const blocked = backlog({ state: "blocked", executionMode: "hitl" });
    const getSummary = vi.fn()
      .mockResolvedValueOnce(summary(active))
      .mockResolvedValueOnce(summary(blocked));
    const kill = vi.fn();
    const exec = vi.fn(async (_command, args) => ({ ok: true, stdout: JSON.stringify({ ok: true, kind: args[1] === "interrupt" ? "backlog.interrupt" : "backlog.retry", data: {} }), stderr: "" }));
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: value => value,
      getBacklog: async () => active,
      getSummary,
      store,
      exec,
      kill,
      isPidAlive: () => true,
      stopTimeoutMs: 0,
    });

    await expect(service.stop("/repo", "42")).resolves.toEqual(summary(blocked));
    expect(kill.mock.calls).toEqual([[1234, "SIGTERM"], [1234, "SIGKILL"]]);
    expect(exec).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      ["backlog", "interrupt", "--id", "42", "--reason", "用户从桌面停止执行", "--json"],
      "/repo",
    );
  });

  it("continues stop recovery when the process exits between the liveness check and SIGTERM", async () => {
    const store = createMemoryStore();
    await store.save("/repo", [{ id: "desktop-42", backlogId: "42", status: "running", startedAt: "2026-09-17T00:00:00.000Z", pid: 1234 }]);
    const active = backlog({ state: "in_progress" });
    const blocked = summary(backlog({ state: "blocked", executionMode: "hitl" }));
    const missing = Object.assign(new Error("missing"), { code: "ESRCH" });
    const exec = vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.interrupt", data: {} }), stderr: "" }));
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: value => value,
      getBacklog: async () => active,
      getSummary: vi.fn().mockResolvedValueOnce(summary(active)).mockResolvedValueOnce(blocked),
      store,
      exec,
      kill: () => { throw missing; },
      isPidAlive: () => true,
      stopTimeoutMs: 0,
    });

    await expect(service.stop("/repo", "42")).resolves.toEqual(blocked);
    expect(exec).toHaveBeenCalledOnce();
    expect((await store.load("/repo"))[0]).toMatchObject({ status: "failed", error: "用户从桌面停止执行" });
  });

  it("recovers only after confirming the PID is dead and runtime is still stale", async () => {
    const stale = summary(backlog({ state: "verification", executionMode: "afk" }), {
      activeRun: { id: "desktop-42", backlogId: "42", status: "failed", startedAt: "2026-09-17T00:00:00.000Z", pid: 1234 },
      runtime: { runId: "run-42", status: "stale", phase: "verifying", heartbeatAt: "2026-09-17T00:00:00.000Z" },
    });
    const blocked = summary(backlog({ state: "blocked", executionMode: "hitl" }));
    const getSummary = vi.fn().mockResolvedValueOnce(stale).mockResolvedValueOnce(stale).mockResolvedValueOnce(blocked);
    const exec = vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.interrupt", data: {} }), stderr: "" }));
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: value => value,
      getBacklog: async () => stale.backlog,
      getSummary,
      store: createMemoryStore(),
      exec,
      isPidAlive: () => false,
    });

    await expect(service.recover("/repo", "42")).resolves.toEqual(blocked);
    expect(getSummary).toHaveBeenCalledTimes(3);
    expect(exec).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      ["backlog", "interrupt", "--id", "42", "--reason", "桌面恢复 stale 运行", "--json"],
      "/repo",
    );
  });

  it("retries through the intent command and preserves the previous template", async () => {
    const store = createMemoryStore();
    await store.save("/repo", [{ id: "desktop-old", backlogId: "42", status: "failed", startedAt: "2026-09-17T00:00:00.000Z", template: "feature-delivery" }]);
    const blocked = backlog({ state: "blocked", executionMode: "hitl" });
    const rework = backlog({ state: "rework", executionMode: "afk" });
    const spawn = vi.fn(() => ({ pid: 4567, once: vi.fn().mockReturnThis(), unref: vi.fn() }));
    const exec = vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.retry", data: {} }), stderr: "" }));
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: value => value,
      getBacklog: vi.fn().mockResolvedValueOnce(rework),
      getSummary: async () => summary(blocked),
      store,
      exec,
      spawn,
    });

    const run = await service.retry("/repo", { backlogId: "42", reason: "已修复失败检查" });

    expect(exec).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      ["backlog", "retry", "--id", "42", "--reason", "已修复失败检查", "--json"],
      "/repo",
    );
    expect(spawn).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      ["loop", "--backlog-id", "42", "--max-iterations", "1", "--template", "feature-delivery"],
      expect.objectContaining({ cwd: "/repo" }),
    );
    expect(run.template).toBe("feature-delivery");
  });

  it("confirms a root merge through the intent command", async () => {
    const mergeReady = backlog({ state: "merge_ready", executionMode: "hitl" });
    const done = summary(backlog({ state: "done", executionMode: "hitl" }));
    const exec = vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.confirm-merge", data: {} }), stderr: "" }));
    const service = createBacklogExecutionService({
      resolveAfk: async () => "/usr/local/bin/afk",
      resolveWorkspace: value => value,
      getBacklog: async () => mergeReady,
      getSummary: vi.fn().mockResolvedValueOnce(summary(mergeReady)).mockResolvedValueOnce(done),
      store: createMemoryStore(),
      exec,
    });

    await expect(service.confirmMerge("/repo", "42")).resolves.toEqual(done);
    expect(exec).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      ["backlog", "confirm-merge", "--id", "42", "--json"],
      "/repo",
    );
  });
});

function backlog(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return { id: "42", title: "工作项", dependsOn: [], state: "ready", executionMode: "afk", tags: [], branchName: "afk/backlog-42", providerRef: "stub:42", ...overrides };
}

function summary(item: BacklogItem, overrides: Partial<BacklogRuntimeSummary> = {}): BacklogRuntimeSummary {
  return { backlogId: item.id, backlog: item, ...overrides };
}
