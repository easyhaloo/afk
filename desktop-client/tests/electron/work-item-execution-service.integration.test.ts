import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutionWorkspaceService } from "../../electron/services/execution-workspace-service";
import { createWorkItemExecutionManifestStore } from "../../electron/services/work-item-execution-manifest-store";
import { createWorkItemExecutionService } from "../../electron/services/work-item-execution-service";
import { createWorkItemRunStore } from "../../electron/services/work-item-run-store";
import { createWorkItemRunHistoryService } from "../../electron/services/work-item-run-history-service";
import type { GlobalWorkItem, WorkItemRunRecord } from "../../shared/backlog-contract";

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for the run lifecycle");
}

describe("work item execution service integration", () => {
  it("runs the execution in process and persists the manifest and full run lifecycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-desktop-execution-integration-"));
    try {
      const project = { platform: "github" as const, projectKey: "acme/api", name: "api" };
    const repository = { ...project, baseBranch: "main" };
      const item: GlobalWorkItem = {
        id: "github:acme/api#42",
        issueNumber: 42,
        project,
        repositories: [repository],
        title: "Coordinate checkout changes",
        managed: true,
        executionEligible: true,
        state: "ready",
        executionMode: "afk",
        dependsOn: [],
        tags: [],
        branchName: "afk/work-item-18",
        providerRef: "github:acme/api#42",
      };
      const workspace = createExecutionWorkspaceService({ baseDirectory: path.join(root, "workspaces") });
      const manifestStore = createWorkItemExecutionManifestStore();
      const persistedRunStore = createWorkItemRunStore({ resolveWorkspace: value => value });
      const observedStatuses: WorkItemRunRecord["status"][] = [];
      const runStore = {
        load: persistedRunStore.load,
        save: async (workspaceRoot: string, runs: WorkItemRunRecord[]) => {
          observedStatuses.push(...runs.map(run => run.status));
          await persistedRunStore.save(workspaceRoot, runs);
        },
      };
      const invocations: Array<{ workItemId: string; manifestPath: string; executionId: string }> = [];
      const service = createWorkItemExecutionService({
        getWorkItem: async () => item,
        workspace,
        manifestStore,
        runStore,
        // Stands in for the execution runtime: it records the call it received
        // next to the manifest, the way a real run would leave evidence.
        execute: async input => {
          invocations.push(input);
          await writeFile(
            path.join(input.manifestPath.replace(/\/[^/]+$/, ""), "execution-invocation.json"),
            JSON.stringify(input),
            "utf8",
          );
          return { status: "done" as const };
        },
      });

      const result = await service.start({
        workItemId: item.id,
        repositories: [{ ...project, checkoutPath: "repositories/api", baseBranch: "main" }],
      });
      expect(result.runId).toBeTruthy();

      const running = (await persistedRunStore.load(result.workspace.root))[0];
      expect(running).toMatchObject({ id: result.runId, status: "running" });
      // The execution runs in this process, so the record names this
      // process: the run history judges a running record by the liveness
      // of the process that owns it.
      expect(running?.pid).toBe(process.pid);
      expect(observedStatuses).toContain("starting");
      expect(observedStatuses).toContain("running");
      expect(await manifestStore.load(result.workspace.root)).toMatchObject({
        workItemId: item.id,
        providerBacklogId: "42",
        tracker: { platform: "github", projectKey: "acme/api" },
        workingBranch: "afk/work-item-18",
        repositories: [expect.objectContaining({ baseBranch: "main", primary: true })],
      });

      const terminal = await waitFor(async () => {
        const run = (await persistedRunStore.load(result.workspace.root))[0];
        return run?.status === "completed" || run?.status === "failed" ? run : undefined;
      });
      expect(terminal).toMatchObject({ id: result.runId, status: "completed" });
      expect(observedStatuses).toContain("completed");
      expect(invocations).toEqual([{
        workItemId: item.id,
        manifestPath: path.join(result.workspace.root, ".afk", "execution-manifest.json"),
        executionId: result.runId,
      }]);
      const invocation = JSON.parse(
        await readFile(path.join(result.workspace.root, ".afk", "execution-invocation.json"), "utf8"),
      ) as { workItemId: string; executionId: string };
      expect(invocation.workItemId).toBe(item.id);
      expect(invocation.executionId).toBe(result.runId);

      // Clearing the workspace pointer is a separate write from flipping the run
      // status to terminal, so it lands asynchronously — read it under waitFor
      // like the surrounding assertions, otherwise this races under load.
      await waitFor(async () => ((await workspace.read(item.id))?.currentRunId === undefined ? true : undefined));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a run this desktop is still executing out of the reconcile's reach", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-desktop-execution-live-"));
    try {
      const project = { platform: "github" as const, projectKey: "acme/api", name: "api" };
      const item: GlobalWorkItem = {
        id: "github:acme/api#42",
        issueNumber: 42,
        project,
        repositories: [{ ...project, baseBranch: "main" }],
        title: "Coordinate checkout changes",
        managed: true,
        executionEligible: true,
        state: "ready",
        executionMode: "afk",
        dependsOn: [],
        tags: [],
        branchName: "afk/work-item-18",
        providerRef: "github:acme/api#42",
      };
      const workspace = createExecutionWorkspaceService({ baseDirectory: path.join(root, "workspaces") });
      const manifestStore = createWorkItemExecutionManifestStore();
      const persistedRunStore = createWorkItemRunStore({ resolveWorkspace: value => value });
      const archiveDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-desktop-execution-archive-"));
      const service = createWorkItemExecutionService({
        getWorkItem: async () => item,
        workspace,
        manifestStore,
        runStore: persistedRunStore,
        // The execution is still running: it settles when the test says so.
        execute: () => new Promise(() => undefined),
      });
      const history = createWorkItemRunHistoryService({
        workspace: { read: workspace.read, updateRun: workspace.updateRun },
        runStore: persistedRunStore,
        isPidAlive: () => true,
        runtimeArchiveDirectory: archiveDirectory,
      });

      const result = await service.start({
        workItemId: item.id,
        repositories: [{ ...project, checkoutPath: "repositories/api", baseBranch: "main" }],
      });

      // The work items list reconciles the persisted runs on every read. A
      // run this desktop is still executing has to survive that: the
      // reconcile used to read a record without an owning process as "the
      // process exited" and fail a run that was still going.
      const merged = await history.merge({ items: [item], projects: [project], diagnostics: [], complete: true });
      expect(merged.items[0].runs?.[0]).toMatchObject({ id: result.runId, status: "running" });
      expect((await persistedRunStore.load(result.workspace.root))[0]).toMatchObject({ status: "running" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
