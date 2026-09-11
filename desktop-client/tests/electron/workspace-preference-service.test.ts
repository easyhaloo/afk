import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readWorkspacePreference, saveWorkspacePreference } from "../../electron/services/workspace-preference-service";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryUserDataDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "afk-workspace-preference-"));
  temporaryDirectories.push(directory);
  return directory;
}

describe("workspace preference service", () => {
  it("persists and restores the selected workspace for packaged launches", async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    const workspace = "/Users/example/project";

    await saveWorkspacePreference(userDataDirectory, workspace);

    await expect(readWorkspacePreference(userDataDirectory)).resolves.toBe(workspace);
  });

  it("ignores malformed preference files", async () => {
    const userDataDirectory = await temporaryUserDataDirectory();
    await writeFile(path.join(userDataDirectory, "workspace.json"), "not-json", "utf8");

    await expect(readWorkspacePreference(userDataDirectory)).resolves.toBeUndefined();
  });
});
