import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readWorkspacePreference, saveWorkspacePreference } from "../../electron/services/workspace-preference-service.js";
import { resolveWorkspace } from "../../electron/services/workspace-service.js";
import { executionWorkspacePath } from "@afk/runtime/infrastructure/workspace";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryUserDataDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afk-workspace-preference-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("workspace preference service", () => {
  it("defaults the desktop selection and execution to the loop workspace", () => {
    vi.stubEnv("AFK_WORKSPACE", "");
    expect(resolveWorkspace()).toBe(path.join(os.homedir(), ".loop-workspace"));
  });

  it("restores the selected project without relocating work item execution", async () => {
    const workspace = await temporaryUserDataDirectory();
    vi.stubEnv("AFK_WORKSPACE", workspace);
    expect(resolveWorkspace()).toBe(workspace);
    expect(executionWorkspacePath("github:acme/api#42")).toBe(path.join(os.homedir(), ".loop-workspace/github/acme/api/42"));
  });

  it("persists and restores the selected workspace for packaged launches", async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    const workspace = path.join(userDataDirectory, "project");
    await mkdir(workspace);

    await saveWorkspacePreference(userDataDirectory, workspace);

    await expect(readWorkspacePreference(userDataDirectory)).resolves.toBe(workspace);
  });

  it("ignores a persisted workspace that no longer exists", async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    const deletedWorkspace = path.join(userDataDirectory, "deleted-worktree");

    await saveWorkspacePreference(userDataDirectory, deletedWorkspace);

    await expect(readWorkspacePreference(userDataDirectory)).resolves.toBeUndefined();
  });

  it("ignores malformed preference files", async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    await writeFile(path.join(userDataDirectory, "workspace.json"), "not-json", "utf8");

    await expect(readWorkspacePreference(userDataDirectory)).resolves.toBeUndefined();
  });
});
