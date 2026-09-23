import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkItemRunHistoryService } from "../../electron/services/work-item-run-history-service";
import { createWorkItemRunStore } from "../../electron/services/work-item-run-store";
import type { WorkItemInventoryResult, WorkItemRunRecord } from "../../shared/backlog-contract";

const root = "/tmp/work-item-run-history-test";
const item = {
  id: "github:acme/api#1", issueNumber: 1,
  project: { platform: "github" as const, projectKey: "acme/api", name: "api" },
  title: "Issue", managed: true, executionEligible: true, state: "ready" as const,
  executionMode: "afk" as const, dependsOn: [], tags: [], branchName: "afk/1", providerRef: "github:acme/api#1",
};
const inventory: WorkItemInventoryResult = { items: [item], projects: [item.project], diagnostics: [], complete: true };
const gitlabItem = {
  ...item,
  id: "gitlab:gitlab.example/group/api#1",
  providerRef: "gitlab:gitlab.example/group/api#1",
  project: { platform: "gitlab" as const, projectKey: "gitlab.example/group/api", providerHost: "gitlab.example", providerProjectId: "246", name: "api" },
};
const gitlabInventory = { ...inventory, items: [gitlabItem] };
const running: WorkItemRunRecord = {
  id: "desktop-1", status: "running", startedAt: "2026-09-23T00:00:00.000Z", pid: 2468, workspacePath: root,
  repositories: [{ platform: "github", projectKey: "acme/api", name: "api", checkoutPath: "repositories/acme/api", baseBranch: "main" }],
};

const archiveDirectories: string[] = [];
afterEach(() => {
  for (const directory of archiveDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function archive(directory: string, overrides: Record<string, unknown> = {}, filename?: string) {
  const record = {
    runId: "afk-1-uuid", backlogId: "1", providerRef: item.providerRef, session: `afk-${item.id}`,
    workspace: path.join(root, "repositories/acme/api"),
    phase: "implementing", status: "completed", sandboxProvider: "local", executionMode: "batch", agentProvider: "codex",
    startedAt: "2026-09-23T00:01:00.000Z", heartbeatAt: "2026-09-23T00:02:00.000Z", completedAt: "2026-09-23T00:02:00.000Z",
    ...overrides,
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, filename ?? `${Buffer.from(String(record.runId)).toString("base64url")}.json`), JSON.stringify(record));
}

function setup(runs: WorkItemRunRecord[], alive = true, workItem = item) {
  const runtimeArchiveDirectory = mkdtempSync(path.join(tmpdir(), "afk-runtime-history-"));
  archiveDirectories.push(runtimeArchiveDirectory);
  const update = vi.fn(async (_root: string, transform: (current: WorkItemRunRecord[]) => Promise<WorkItemRunRecord[] | undefined> | WorkItemRunRecord[] | undefined) => {
    const next = await transform(runs);
    if (next) runs.splice(0, runs.length, ...next);
  });
  const updateRun = vi.fn(async () => undefined);
  const service = createWorkItemRunHistoryService({
    workspace: { read: vi.fn(async () => ({ root, taskId: workItem.id, cleanupStatus: "active" as const, currentRunId: "desktop-1" })), updateRun },
    runStore: { update },
    isPidAlive: () => alive,
    now: () => new Date("2026-09-23T01:00:00.000Z"),
    runtimeArchiveDirectory,
  });
  return { service, update, updateRun, runtimeArchiveDirectory };
}

describe("work item run history service", () => {
  it("merges persisted local runs without mutating the cached provider inventory", async () => {
    const runs = [running];
    const { service, update, updateRun } = setup(runs);
    const first = await service.merge(inventory);
    expect(first.items[0].runs).toEqual([running]);
    expect(inventory.items[0].runs).toBeUndefined();
    expect(update).toHaveBeenCalledOnce();
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("reconciles a dead process after restart, persists failure, and clears its current run", async () => {
    const runs = [running];
    const { service, update, updateRun } = setup(runs, false);
    const first = await service.merge(inventory);
    expect(first.items[0].runs?.[0]).toMatchObject({ status: "failed", completedAt: "2026-09-23T01:00:00.000Z" });
    expect(update).toHaveBeenCalledOnce();
    expect(updateRun).toHaveBeenCalledWith(item.id, undefined, "desktop-1");
    await service.merge(inventory);
    expect(update).toHaveBeenCalledTimes(2);
  });

  it("gives a newly exited process time to deliver its child exit event", async () => {
    const fresh = { ...running, startedAt: "2026-09-23T00:59:58.000Z" };
    const runs = [fresh];
    const { service, updateRun } = setup(runs, false);
    expect((await service.merge(inventory)).items[0].runs?.[0].status).toBe("running");
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("uses the canonical completed archive instead of falsely failing a dead detached CLI", async () => {
    const runs = [running];
    const { service, updateRun, runtimeArchiveDirectory } = setup(runs, false);
    archive(runtimeArchiveDirectory);
    const result = await service.merge(inventory);
    expect(result.items[0].runs?.[0]).toMatchObject({ status: "completed", completedAt: "2026-09-23T00:02:00.000Z" });
    expect(runs[0].status).toBe("completed");
    expect(updateRun).toHaveBeenCalledWith(item.id, undefined, "desktop-1");
  });

  it("restores a completed GitLab CLI archive with a numeric project ID after desktop restart", async () => {
    const workspaceRoot = mkdtempSync(path.join(tmpdir(), "afk-gitlab-workspace-"));
    const runtimeArchiveDirectory = mkdtempSync(path.join(tmpdir(), "afk-gitlab-archive-"));
    archiveDirectories.push(workspaceRoot, runtimeArchiveDirectory);
    const run: WorkItemRunRecord = {
      ...running,
      workspacePath: workspaceRoot,
      repositories: [{ platform: "gitlab", projectKey: gitlabItem.project.projectKey, name: "api", checkoutPath: "repositories/acme/api", baseBranch: "main" }],
    };
    const createStore = () => createWorkItemRunStore({ resolveWorkspace: workspace => workspace });
    await createStore().save(workspaceRoot, [run]);
    archive(runtimeArchiveDirectory, {
      providerRef: "gitlab:246#1", session: `afk-${gitlabItem.id}`,
      workspace: path.join(workspaceRoot, "repositories/acme/api"),
    });
    const restartedStore = createStore();
    const updateRun = vi.fn(async () => undefined);
    const service = createWorkItemRunHistoryService({
      workspace: { read: async () => ({ root: workspaceRoot, taskId: gitlabItem.id, cleanupStatus: "active", currentRunId: run.id }), updateRun },
      runStore: restartedStore,
      isPidAlive: () => false,
      now: () => new Date("2026-09-23T01:00:00.000Z"),
      runtimeArchiveDirectory,
    });

    expect((await service.merge(gitlabInventory)).items[0].runs?.[0]).toMatchObject({
      status: "completed", completedAt: "2026-09-23T00:02:00.000Z",
    });
    expect((await restartedStore.load(workspaceRoot))[0].status).toBe("completed");
    expect(updateRun).toHaveBeenCalledWith(gitlabItem.id, undefined, "desktop-1");
  });

  it.each([
    ["another project", { providerRef: "gitlab:247#1" }],
    ["another issue", { providerRef: "gitlab:246#2" }],
    ["another session", { providerRef: "gitlab:246#1", session: "afk-gitlab:gitlab.example/group/other#1" }],
    ["another checkout", { providerRef: "gitlab:246#1", workspace: path.join(root, "repositories/other/api") }],
  ])("does not attribute %s's GitLab archive to this work item", async (_identity, overrides) => {
    const { service, runtimeArchiveDirectory } = setup([running], false, gitlabItem);
    archive(runtimeArchiveDirectory, { session: `afk-${gitlabItem.id}`, ...overrides });
    expect((await service.merge(gitlabInventory)).items[0].runs?.[0]).toMatchObject({
      status: "failed", error: "AFK 进程已退出，未收到运行终态",
    });
  });

  it.each([
    ["blocked", "AFK is blocked"],
    ["failed", "AFK failed"],
  ] as const)("maps an archived %s result to a desktop failure", async (status, errorSummary) => {
    const { service, runtimeArchiveDirectory } = setup([running], false);
    archive(runtimeArchiveDirectory, { status, errorSummary });
    expect((await service.merge(inventory)).items[0].runs?.[0]).toMatchObject({
      status: "failed", completedAt: "2026-09-23T00:02:00.000Z", error: errorSummary,
    });
  });

  it.each([
    ["another issue", { backlogId: "2" }],
    ["another provider", { providerRef: "github:other/api#1" }],
    ["another launch", { session: "afk-github:other/api#1" }],
    ["another checkout", { workspace: path.join(root, "repositories/other/api") }],
    ["an older run", { startedAt: "2026-09-22T23:59:00.000Z" }],
    ["a future run", { startedAt: "2026-09-23T02:00:00.000Z", completedAt: "2026-09-23T02:01:00.000Z" }],
    ["invalid completion time", { completedAt: "not-a-date" }],
    ["incomplete runtime metadata", { heartbeatAt: undefined }],
    ["invalid runtime phase", { phase: "unknown" }],
  ])("does not attribute %s's archived terminal to this desktop run", async (_name, overrides) => {
    const { service, runtimeArchiveDirectory } = setup([running], false);
    archive(runtimeArchiveDirectory, overrides);
    expect((await service.merge(inventory)).items[0].runs?.[0]).toMatchObject({
      status: "failed", completedAt: "2026-09-23T01:00:00.000Z", error: "AFK 进程已退出，未收到运行终态",
    });
  });

  it("does not use an earlier desktop run's terminal after a newer run starts", async () => {
    const later = { ...running, id: "desktop-2", startedAt: "2026-09-23T00:30:00.000Z" };
    const { service, runtimeArchiveDirectory } = setup([running, later], false);
    archive(runtimeArchiveDirectory);
    const result = await service.merge(inventory);
    expect(result.items[0].runs?.find(run => run.id === "desktop-1")?.status).toBe("completed");
    expect(result.items[0].runs?.find(run => run.id === "desktop-2")?.status).toBe("failed");
  });

  it("rejects forged archive filenames and symlinks", async () => {
    const { service, runtimeArchiveDirectory } = setup([running], false);
    archive(runtimeArchiveDirectory, {}, "forged.json");
    const external = mkdtempSync(path.join(tmpdir(), "afk-runtime-external-"));
    archiveDirectories.push(external);
    archive(external);
    symlinkSync(path.join(external, `${Buffer.from("afk-1-uuid").toString("base64url")}.json`), path.join(runtimeArchiveDirectory, `${Buffer.from("afk-1-uuid").toString("base64url")}.json`));
    expect((await service.merge(inventory)).items[0].runs?.[0].status).toBe("failed");
  });

  it("rejects untrusted workspace metadata and checkout traversal", async () => {
    const runs = [{ ...running, repositories: [{ ...running.repositories![0], checkoutPath: "repositories/acme/../acme/api" }] }];
    const { service, runtimeArchiveDirectory } = setup(runs, false);
    archive(runtimeArchiveDirectory);
    expect((await service.merge(inventory)).items[0].runs?.[0].status).toBe("failed");
  });

  it("does not persist a guessed failure when the archive cannot be read", async () => {
    const runs = [running];
    const { service, runtimeArchiveDirectory } = setup(runs, false);
    rmSync(runtimeArchiveDirectory, { recursive: true });
    writeFileSync(runtimeArchiveDirectory, "not a directory");
    await expect(service.merge(inventory)).rejects.toThrow();
    expect(runs[0].status).toBe("running");
  });

  it("allows a just-created run without a PID time to spawn before reconciling", async () => {
    const starting = { ...running, status: "starting" as const, startedAt: "2026-09-23T00:59:30.000Z", pid: undefined };
    const runs = [starting];
    const { service } = setup(runs);
    expect((await service.merge(inventory)).items[0].runs?.[0].status).toBe("starting");
    expect(runs[0].status).toBe("starting");
  });

  it("retains provider history and replaces matching IDs with authoritative local state", async () => {
    const { service } = setup([running]);
    const provider = { ...inventory, items: [{ ...item, runs: [{ ...running, status: "starting" as const }, { ...running, id: "older", status: "completed" as const }] }] };
    expect((await service.merge(provider)).items[0].runs).toEqual([running, provider.items[0].runs[1]]);
  });
});
