import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkItemRunStore } from "../../electron/services/work-item-run-store";

describe("work item run store", () => {
  it("round-trips runs through an atomic workspace-local file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    const run = { id: "desktop-run-1", status: "running" as const, startedAt: "2026-09-21T08:00:00.000Z", workspacePath: root, pid: 123 };

    await store.save(root, [run]);

    expect(await store.load(root)).toEqual([run]);
    expect(await readFile(path.join(root, ".afk", "work-item-runs.json"), "utf8")).toContain("desktop-run-1");
  });

  it("ignores malformed stored data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    await store.save(root, [{ id: "desktop-run-1", status: "running", startedAt: "now" }]);

    const file = path.join(root, ".afk", "work-item-runs.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, JSON.stringify([{ id: "invalid" }, { id: "desktop-run-2", status: "failed", startedAt: "now", error: "boom" }]));

    expect(await store.load(root)).toEqual([{ id: "desktop-run-2", status: "failed", startedAt: "now", error: "boom" }]);
  });
});
