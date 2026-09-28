import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectRunScopeService } from "../../electron/services/project-run-scope-service";

describe("project run scope", () => {
  it("finds runs in matching task workspaces without leaking another project", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-project-run-scope-"));
    const selected = path.join(baseDirectory, "checkout");
    await mkdir(selected);
    const matching = path.join(baseDirectory, "github", "easyhaloo", "afk", "144");
    const unrelated = path.join(baseDirectory, "github", "elsewhere", "afk", "99");
    for (const [root, projectKey, runId] of [
      [matching, "easyhaloo/afk", "run-144"],
      [unrelated, "elsewhere/afk", "run-99"],
    ]) {
      await mkdir(path.join(root, ".afk"), { recursive: true });
      await writeFile(path.join(root, "workspace.json"), JSON.stringify({
        taskId: `github:${projectKey}#${runId === "run-144" ? "144" : "99"}`,
        root,
        repositories: [{ project: { platform: "github", projectKey }, path: path.join(root, "repositories", "afk") }],
      }));
      await writeFile(path.join(root, ".afk", "work-item-runs.json"), JSON.stringify([
        { id: runId, status: "running", startedAt: "2026-09-24T09:23:23.815Z", workspacePath: root },
      ]));
    }
    const service = createProjectRunScopeService({ baseDirectory, remoteUrl: async () => "git@github.com:easyhaloo/afk.git" });

    expect(await service.workspaces(selected)).toEqual([selected, matching]);
    expect(await service.runs(selected)).toEqual([{
      id: "run-144", workItemId: "github:easyhaloo/afk#144", status: "running",
      startedAt: "2026-09-24T09:23:23.815Z", workspacePath: matching,
    }]);
  });

  it("uses the selected task workspace without a Git remote, and rejects invalid metadata", async () => {
    const baseDirectory = await mkdtemp(path.join(os.tmpdir(), "afk-project-run-scope-"));
    const matching = path.join(baseDirectory, "github", "easyhaloo", "afk", "144");
    const spoofed = path.join(baseDirectory, "github", "easyhaloo", "afk", "145");
    await mkdir(matching, { recursive: true });
    await mkdir(spoofed);
    await writeFile(path.join(matching, "workspace.json"), JSON.stringify({ taskId: "github:easyhaloo/afk#144", root: matching, repositories: [] }));
    await writeFile(path.join(spoofed, "workspace.json"), JSON.stringify({ taskId: "github:easyhaloo/afk#145", root: matching, repositories: [] }));
    const service = createProjectRunScopeService({ baseDirectory, remoteUrl: async () => "" });

    expect(await service.workspaces(matching)).toEqual([matching]);
    expect(await service.workspaces(spoofed)).toEqual([spoofed]);
  });
});
