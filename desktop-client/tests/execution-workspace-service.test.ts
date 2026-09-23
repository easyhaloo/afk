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
  it("does not clear a newer current run when an older run finishes", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });
    await service.allocate("WI-2026-018", [project]);
    await service.updateRun("WI-2026-018", "newer-run");
    expect((await service.updateRun("WI-2026-018", undefined, "older-run")).currentRunId).toBe("newer-run");
    expect((await service.updateRun("WI-2026-018", undefined, "newer-run")).currentRunId).toBeUndefined();
  });
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

  it("uses shared collision-safe checkout paths for real repository directories", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });
    const projects = [
      { platform: "github" as const, projectKey: "acme/repo-upper", name: "Repo" },
      { platform: "github" as const, projectKey: "acme/repo-lower", name: "repo" },
      { platform: "gitlab" as const, projectKey: "acme/shared-space", name: "shared repo" },
      { platform: "gitlab" as const, projectKey: "acme/shared-slash", name: "shared/repo" },
      { platform: "github" as const, projectKey: "acme/custom", name: "ignored", checkoutPath: "repositories/custom-checkout" },
    ];

    const workspace = await service.allocate("WI-2026-019", projects);

    expect(workspace.repositories.map(repository => path.relative(workspace.root, repository.path).split(path.sep).join("/"))).toEqual([
      "repositories/Repo",
      "repositories/repo-2",
      "repositories/shared-repo",
      "repositories/shared-repo-2",
      "repositories/custom-checkout",
    ]);
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

  it("refreshes repository mappings when a later run selects a different repository", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });
    const first = await service.allocate("WI-2026-018", [project]);
    await service.updateRun("WI-2026-018", "previous-run");
    await service.markCleaned("WI-2026-018");

    const second = await service.allocate("WI-2026-018", [webProject]);
    expect(second.repositories).toEqual([{ project: webProject, path: path.join(first.root, "repositories", "console") }]);
    expect(second.currentRunId).toBe("previous-run");
    expect(second.cleanupStatus).toBe("cleaned");
    expect(second.createdAt).toBe(first.createdAt);
    expect((await service.read("WI-2026-018"))?.repositories).toEqual(second.repositories);

    const combined = await service.allocate("WI-2026-018", [project, webProject]);
    expect(combined.repositories).toHaveLength(2);
    expect((await service.read("WI-2026-018"))?.repositories).toEqual(combined.repositories);
  });

  it("tracks the current run and cleanup status", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });

    await service.allocate("WI-2026-018", [project]);
    await service.updateRun("WI-2026-018", "run-1");
    expect((await service.read("WI-2026-018"))?.currentRunId).toBe("run-1");
    expect((await service.markCleaned("WI-2026-018")).cleanupStatus).toBe("cleaned");
  });

  it("preserves independent run and cleanup updates across service instances", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });
    const otherService = createExecutionWorkspaceService({ baseDirectory });

    for (let index = 0; index < 12; index++) {
      const taskId = `WI-2026-${index + 100}`;
      await service.allocate(taskId, [project]);
      await Promise.all([
        service.updateRun(taskId, `run-${index}`),
        otherService.markCleaned(taskId),
      ]);
      expect(await service.read(taskId)).toMatchObject({ currentRunId: `run-${index}`, cleanupStatus: "cleaned" });
    }
  });

  it("keeps selected repositories and existing metadata during concurrent allocation and updates", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-loop-workspace-"));
    const service = createExecutionWorkspaceService({ baseDirectory });
    const otherService = createExecutionWorkspaceService({ baseDirectory });

    for (let index = 0; index < 12; index++) {
      const taskId = `WI-2026-${index + 200}`;
      const initial = await service.allocate(taskId, [project]);
      await Promise.all([
        service.allocate(taskId, [webProject]),
        otherService.updateRun(taskId, `run-${index}`),
        service.markCleaned(taskId),
      ]);
      expect(await service.read(taskId)).toMatchObject({
        repositories: [{ project: webProject, path: path.join(initial.root, "repositories", "console") }],
        currentRunId: `run-${index}`,
        cleanupStatus: "cleaned",
        createdAt: initial.createdAt,
      });
    }
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
