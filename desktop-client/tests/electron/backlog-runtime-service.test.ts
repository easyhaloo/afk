import { createTaskRuntimePort } from "@afk/execution/application/runtime/task-runtime-port";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { BacklogItem, BacklogRunSummary } from "../../shared/backlog-contract";
import { createBacklogRuntimeService } from "../../electron/services/backlog-runtime-service";

const backlog: BacklogItem = {
  id: "42",
  title: "Ship runtime summary",
  dependsOn: [],
  state: "ready",
  executionMode: "afk",
  tags: [],
  branchName: "afk/backlog-42",
  providerRef: "stub:42",
};

function runStore(runs: BacklogRunSummary[]) {
  return { load: async () => runs } as never;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "afk-backlog-runtime-"));
  await mkdir(path.join(root, "active"), { recursive: true });
  await mkdir(path.join(root, "archive"), { recursive: true });
  return root;
}

function createService(root: string, runs: BacklogRunSummary[] = [], now = Date.parse("2026-09-15T00:10:00.000Z"), isPidAlive = () => true) {
  return createBacklogRuntimeService({
    resolveWorkspace: value => value,
    getBacklog: async () => backlog,
    runStore: runStore(runs),
    taskRuntime: createTaskRuntimePort({ root, now: () => now }),
    now: () => now,
    isPidAlive,
  });
}

/** The service with no liveness probe injected: its own probe decides. */
function createServiceWithDefaultProbe(root: string, runs: BacklogRunSummary[]) {
  return createBacklogRuntimeService({
    resolveWorkspace: value => value,
    getBacklog: async () => backlog,
    runStore: runStore(runs),
    taskRuntime: createTaskRuntimePort({ root, now: () => Date.parse("2026-09-15T00:10:00.000Z") }),
    now: () => Date.parse("2026-09-15T00:10:00.000Z"),
  });
}

/** The pid of a process that has already exited. */
function exitedPid(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    child.on("exit", () => resolve(child.pid ?? 0));
    child.on("error", reject);
  });
}

describe("backlog runtime service", () => {
  it("joins the latest active runtime by backlogId", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "active", "run.json"), JSON.stringify({ backlogId: "42", runId: "run-42", status: "running", phase: "implementing", workspace: root, providerRef: "stub:42", startedAt: "2026-09-15T00:08:00.000Z", heartbeatAt: "2026-09-15T00:09:00.000Z", branch: "afk/backlog-42" }));
    const result = await createService(root).summary(root, "42");
    expect(result.runtime).toMatchObject({ runId: "run-42", status: "running", branch: "afk/backlog-42" });
  });

  it("marks an old running runtime stale without changing the backlog state", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "active", "run.json"), JSON.stringify({ backlogId: "42", runId: "run-42", status: "running", phase: "verifying", workspace: root, providerRef: "stub:42", startedAt: "2026-09-14T22:59:00.000Z", heartbeatAt: "2026-09-14T23:00:00.000Z" }));
    const result = await createService(root).summary(root, "42");
    expect(result.backlog.state).toBe("ready");
    expect(result.runtime?.status).toBe("stale");
  });

  it("keeps a backlog visible when runtime data is missing or malformed", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "active", "bad.json"), "not-json");
    const result = await createService(root).summary(root, "42");
    expect(result.backlogId).toBe("42");
    expect(result.runtime).toBeUndefined();
  });

  it("reports a dead launch as failed before a canonical runtime exists", async () => {
    const root = await fixture();
    const result = await createService(root, [{ id: "launch-42", backlogId: "42", status: "running", startedAt: "2026-09-15T00:00:00.000Z", pid: 1234 }], undefined, () => false).summary(root, "42");
    expect(result.activeRun).toMatchObject({ status: "failed", error: expect.stringContaining("canonical runtime") });
  });

  it("judges a live process by its own probe, not by an assumption", async () => {
    const root = await fixture();
    const dead = await exitedPid();

    // No probe is injected here: the service has to work out for itself
    // whether the process is still there. A run whose process is alive is
    // not a failed run, and one whose process is gone is.
    const live = await createServiceWithDefaultProbe(root, [
      { id: "launch-42", backlogId: "42", status: "running", startedAt: "2026-09-15T00:00:00.000Z", pid: process.pid },
    ]).summary(root, "42");
    expect(live.activeRun?.status).not.toBe("failed");

    const gone = await createServiceWithDefaultProbe(root, [
      { id: "launch-42", backlogId: "42", status: "running", startedAt: "2026-09-15T00:00:00.000Z", pid: dead },
    ]).summary(root, "42");
    expect(gone.activeRun).toMatchObject({ status: "failed", error: expect.stringContaining("canonical runtime") });
  });

  it("does not treat a clean process exit without a runtime record as completed work", async () => {
    const root = await fixture();
    const result = await createService(root, [{ id: "launch-42", backlogId: "42", status: "completed", startedAt: "2026-09-15T00:00:00.000Z", pid: 1234 }]).summary(root, "42");
    expect(result.activeRun).toMatchObject({ status: "failed", error: expect.stringContaining("canonical runtime") });
  });

  it("prefers canonical runtime status when the launch process has disappeared", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "archive", "run.json"), JSON.stringify({ backlogId: "42", runId: "run-42", status: "completed", phase: "verifying", workspace: root, providerRef: "stub:42", startedAt: "2026-09-15T00:00:01.000Z", heartbeatAt: "2026-09-15T00:09:00.000Z" }));
    const result = await createService(root, [{ id: "launch-42", backlogId: "42", status: "running", startedAt: "2026-09-15T00:00:00.000Z", pid: 1234 }], undefined, () => false).summary(root, "42");
    expect(result.runtime?.status).toBe("completed");
    expect(result.activeRun?.status).toBe("running");
  });

  it("ignores a runtime from another workspace even when backlogId matches", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "active", "other-workspace.json"), JSON.stringify({
      backlogId: "42",
      runId: "run-other-42",
      status: "running",
      phase: "implementing",
      workspace: "/another/repository",
      providerRef: "github:another/repository#42",
      startedAt: "2026-09-15T00:08:00.000Z",
      heartbeatAt: "2026-09-15T00:09:00.000Z",
    }));

    const result = await createService(root).summary(root, "42");
    expect(result.runtime).toBeUndefined();
  });

  it("does not let an older archived runtime hide a failed current launch", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "archive", "old-run.json"), JSON.stringify({
      backlogId: "42",
      runId: "run-old-42",
      status: "completed",
      phase: "verifying",
      workspace: root,
      providerRef: "stub:42",
      startedAt: "2026-09-14T23:00:00.000Z",
      heartbeatAt: "2026-09-14T23:10:00.000Z",
    }));

    const result = await createService(root, [{ id: "launch-42", backlogId: "42", status: "running", startedAt: "2026-09-15T00:00:00.000Z", pid: 1234 }], undefined, () => false).summary(root, "42");

    expect(result.runtime).toBeUndefined();
    expect(result.activeRun).toMatchObject({ status: "failed", error: expect.stringContaining("canonical runtime") });
  });

  it("ignores runtime records with malformed timestamps", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "active", "bad-time.json"), JSON.stringify({
      backlogId: "42",
      runId: "run-bad-time",
      status: "running",
      phase: "implementing",
      workspace: root,
      providerRef: "stub:42",
      startedAt: "not-a-date",
      heartbeatAt: "still-not-a-date",
    }));

    const result = await createService(root).summary(root, "42");
    expect(result.runtime).toBeUndefined();
  });

  it("reads a runtime record written before the environment fields existed", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "active", "legacy.json"), JSON.stringify({
      backlogId: "42",
      runId: "legacy-42",
      status: "running",
      phase: "implementing",
      worktree: path.join(root, "worktree"),
      startedAt: "2026-09-15T00:08:00.000Z",
      heartbeatAt: "2026-09-15T00:09:00.000Z",
    }));

    const result = await createService(root).summary(root, "42");
    expect(result.runtime?.runId).toBe("legacy-42");
  });

  it("reads a legacy runtime record only when its worktree is inside the workspace", async () => {
    const root = await fixture();
    await writeFile(path.join(root, "active", "legacy.json"), JSON.stringify({
      backlogId: "42",
      runId: "legacy-42",
      status: "running",
      phase: "implementing",
      worktree: "/another/repository/worktree",
      startedAt: "2026-09-15T00:08:00.000Z",
      heartbeatAt: "2026-09-15T00:09:00.000Z",
    }));

    const result = await createService(root).summary(root, "42");
    expect(result.runtime).toBeUndefined();
  });
});
