import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutionWorkspaceService } from "../../electron/services/execution-workspace-service";
import { createWorkItemExecutionManifestStore } from "../../electron/services/work-item-execution-manifest-store";
import { createWorkItemExecutionService } from "../../electron/services/work-item-execution-service";
import { createWorkItemRunStore } from "../../electron/services/work-item-run-store";
import type { GlobalWorkItem, WorkItemRunRecord } from "../../shared/backlog-contract";

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for child process state");
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("work item execution service process integration", () => {
  it("forks a detached executable and persists the manifest and full run lifecycle", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-desktop-process-integration-"));
    let childPid: number | undefined;
    try {
      const shim = path.join(root, "afk-shim");
      await writeFile(shim, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
fs.writeFileSync(path.join(process.cwd(), ".afk", "shim-invocation.json"), JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));
setTimeout(() => process.exit(0), 400);
`, "utf8");
      await chmod(shim, 0o755);

      const project = { platform: "github" as const, projectKey: "acme/api", name: "api" };
      const item: GlobalWorkItem = {
        id: "WI-2026-018",
        issueNumber: 42,
        project,
        repositories: [project],
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
      const service = createWorkItemExecutionService({
        getWorkItem: async () => item,
        resolveAfk: async () => shim,
        workspace,
        manifestStore,
        runStore,
      });

      const result = await service.start({
        workItemId: item.id,
        repositories: [{ ...project, checkoutPath: "repositories/api", baseBranch: "main" }],
      });
      expect(result.runId).toBeTruthy();

      const running = (await persistedRunStore.load(result.workspace.root))[0];
      expect(running).toMatchObject({ id: result.runId, status: "running", pid: expect.any(Number) });
      childPid = running.pid;
      expect(childPid).toBeTypeOf("number");
      expect(observedStatuses).toContain("starting");
      expect(observedStatuses).toContain("running");
      expect(await manifestStore.load(result.workspace.root)).toMatchObject({
        workItemId: item.id,
        providerBacklogId: "42",
        tracker: { platform: "github", projectKey: "acme/api" },
        workingBranch: "afk/work-item-18",
        repositories: [expect.objectContaining({ baseBranch: "main", primary: true })],
      });

      const invocation = await waitFor(async () => {
        try {
          return JSON.parse(await readFile(path.join(result.workspace.root, ".afk", "shim-invocation.json"), "utf8")) as { pid: number; args: string[] };
        } catch {
          return undefined;
        }
      });
      expect(invocation.pid).toBe(childPid);
      expect(invocation.args).toEqual([
        "run", "--backlog-id", item.id, "--execution-manifest",
        path.join(result.workspace.root, ".afk", "execution-manifest.json"),
      ]);

      const terminal = await waitFor(async () => {
        const run = (await persistedRunStore.load(result.workspace.root))[0];
        return run?.status === "completed" || run?.status === "failed" ? run : undefined;
      });
      expect(terminal).toMatchObject({ id: result.runId, status: "completed", pid: childPid });
      expect(observedStatuses).toContain("completed");
      expect((await workspace.read(item.id))?.currentRunId).toBeUndefined();
      await waitFor(async () => childPid !== undefined && !processIsAlive(childPid) ? true : undefined);
    } finally {
      if (childPid !== undefined && processIsAlive(childPid)) {
        try { process.kill(-childPid, "SIGTERM"); } catch { /* already stopped */ }
        try { process.kill(childPid, "SIGTERM"); } catch { /* already stopped */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
