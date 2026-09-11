import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBacklogRunStore } from "../../electron/services/backlog-run-store";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("backlog run store", () => {
  it("persists run summaries under the workspace AFK directory", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "afk-run-store-"));
    temporaryDirectories.push(workspace);
    const store = createBacklogRunStore({ resolveWorkspace: (input) => input });
    const runs = [{ id: "run-1", backlogId: "42", status: "running" as const, startedAt: "2026-09-08T10:00:00.000Z", pid: 1234 }];

    await store.save(workspace, runs);

    await expect(store.load(workspace)).resolves.toEqual(runs);
  });

  it("treats a missing store as empty", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "afk-run-store-"));
    temporaryDirectories.push(workspace);
    const store = createBacklogRunStore({ resolveWorkspace: (input) => input });

    await expect(store.load(workspace)).resolves.toEqual([]);
  });
});
