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

const webProject = {
  platform: "gitlab" as const,
  projectKey: "platform/console",
  name: "console",
};

describe("execution workspace service", () => {
  it("creates an isolated task directory with metadata and standard subdirectories", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory, now: () => new Date("2026-09-18T00:00:00.000Z") });

    const workspace = await service.allocate("WI-2026-018", [project, webProject]);

    expect(workspace.root).toBe(path.join(baseDirectory, "WI-2026-018"));
    expect(workspace.repositoriesRoot).toBe(path.join(workspace.root, "repositories"));
    expect(workspace.repositories).toEqual([
      { project, path: path.join(workspace.root, "repositories", "api") },
      { project: webProject, path: path.join(workspace.root, "repositories", "console") },
    ]);
    expect(workspace.artifacts).toBe(path.join(workspace.root, "artifacts"));
    expect(workspace.runtime).toBe(path.join(workspace.root, "runtime"));
    expect(workspace.logs).toBe(path.join(workspace.root, "logs"));
    expect(workspace.diagnostics).toBe(path.join(workspace.root, "diagnostics"));
    expect(JSON.parse(await readFile(path.join(workspace.root, "workspace.json"), "utf8"))).toMatchObject({
      taskId: "WI-2026-018",
      repositories: [
        { project: { projectKey: "acme/api" }, path: path.join(workspace.root, "repositories", "api") },
        { project: { projectKey: "platform/console" }, path: path.join(workspace.root, "repositories", "console") },
      ],
      cleanupStatus: "active",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
  });

  it("is idempotent for the same task and keeps the original creation time", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    let currentTime = new Date("2026-09-18T00:00:00.000Z");
    const service = createExecutionWorkspaceService({ baseDirectory, now: () => currentTime });

    const first = await service.allocate("WI-2026-018", [project]);
    currentTime = new Date("2026-09-19T00:00:00.000Z");
    const second = await service.allocate("WI-2026-018", [project]);

    expect(second).toEqual(first);
  });

  it("tracks the current run and cleanup status", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });

    await service.allocate("WI-2026-018", [project]);
    await service.updateRun("WI-2026-018", "run-1");
    expect((await service.read("WI-2026-018"))?.currentRunId).toBe("run-1");
    expect((await service.markCleaned("WI-2026-018")).cleanupStatus).toBe("cleaned");
  });

  it("keeps canonical provider issue IDs compatible", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });

    const workspace = await service.allocate("github:acme/api#42", [project]);

    expect(workspace.root).toBe(path.join(baseDirectory, "github", "acme", "api", "42"));
  });

  it.each(["", "../task", "WI 2026 018", "github:../api#1", "github:acme/api#0", "github:acme/api#1 "]) ("rejects unsafe task ID %j", async taskId => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });

    await expect(service.allocate(taskId, [project])).rejects.toThrow();
  });
});
