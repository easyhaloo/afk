import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createExecutionWorkspaceService } from "../electron/services/execution-workspace-service";

const project = {
  platform: "github" as const,
  projectKey: "acme/api",
  name: "api",
};

describe("execution workspace service", () => {
  it("creates an isolated task directory with metadata and standard subdirectories", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory, now: () => new Date("2026-09-18T00:00:00.000Z") });

    const workspace = await service.allocate("github:acme/api#42", project);

    expect(workspace.root).toBe(path.join(baseDirectory, "github%3Aacme%2Fapi%2342"));
    expect(workspace.checkout).toBe(path.join(workspace.root, "checkout"));
    expect(workspace.runtime).toBe(path.join(workspace.root, "runtime"));
    expect(workspace.logs).toBe(path.join(workspace.root, "logs"));
    expect(workspace.diagnostics).toBe(path.join(workspace.root, "diagnostics"));
    expect(JSON.parse(await readFile(path.join(workspace.root, "workspace.json"), "utf8"))).toMatchObject({
      taskId: "github:acme/api#42",
      cleanupStatus: "active",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
  });

  it("is idempotent for the same task and keeps the original creation time", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    let currentTime = new Date("2026-09-18T00:00:00.000Z");
    const service = createExecutionWorkspaceService({ baseDirectory, now: () => currentTime });

    const first = await service.allocate("github:acme/api#42", project);
    currentTime = new Date("2026-09-19T00:00:00.000Z");
    const second = await service.allocate("github:acme/api#42", project);

    expect(second).toEqual(first);
  });

  it("tracks the current run and cleanup status", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });

    await service.allocate("github:acme/api#42", project);
    await service.updateRun("github:acme/api#42", "run-1");
    expect((await service.read("github:acme/api#42"))?.currentRunId).toBe("run-1");
    expect((await service.markCleaned("github:acme/api#42")).cleanupStatus).toBe("cleaned");
  });

  it.each(["", "github:../api#1", "github:acme/api#0", "github:acme/api#1 "]) ("rejects unsafe task ID %j", async taskId => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });

    await expect(service.allocate(taskId, project)).rejects.toThrow();
  });
});
