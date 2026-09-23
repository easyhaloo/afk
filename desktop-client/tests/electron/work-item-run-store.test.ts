import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createWorkItemRunStore } from "../../electron/services/work-item-run-store";
import { parseWorkItemRunRecord } from "../../shared/backlog-contract";

describe("work item run store", () => {
  it("round-trips runs through an atomic workspace-local file", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    const run = {
      id: "desktop-run-1",
      status: "running" as const,
      startedAt: "2026-09-21T08:00:00.000Z",
      workingBranch: "afk/work-item-1",
      repositories: [{
        platform: "github" as const,
        projectKey: "acme/api",
        name: "api",
        checkoutPath: "repositories/api",
        baseBranch: "main",
      }],
      workspacePath: root,
      pid: 123,
    };

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
    await writeFile(file, JSON.stringify([
      { id: "invalid" },
      { id: "unknown-field", status: "failed", startedAt: "now", unexpected: true },
      { id: "", status: "failed", startedAt: "now" },
      { id: "empty-started-at", status: "failed", startedAt: "" },
      { id: "bad-branch", status: "failed", startedAt: "now", workingBranch: "bad..branch" },
      {
        id: "bad-repository",
        status: "failed",
        startedAt: "now",
        repositories: [{ platform: "github", projectKey: "acme/api", name: "api", checkoutPath: "../api", baseBranch: "main" }],
      },
      { id: "desktop-run-2", status: "failed", startedAt: "now", error: "boom" },
    ]));

    expect(await store.load(root)).toEqual([{ id: "desktop-run-2", status: "failed", startedAt: "now", error: "boom" }]);
    for (const invalid of [
      { id: "unknown-field", status: "failed", startedAt: "now", unexpected: true },
      { id: "", status: "failed", startedAt: "now" },
      { id: "empty-started-at", status: "failed", startedAt: "" },
    ]) expect(() => parseWorkItemRunRecord(invalid)).toThrow();
  });

  it("continues to load legacy records without repository context", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    const legacy = { id: "legacy-run", status: "completed" as const, startedAt: "2026-09-20T01:00:00.000Z", completedAt: "2026-09-20T02:00:00.000Z" };

    await store.save(root, [legacy]);

    await expect(store.load(root)).resolves.toEqual([legacy]);
  });

  it("serializes concurrent updates for one workspace without losing either run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    let releaseFirst: () => void = () => undefined;
    const firstPaused = new Promise<void>(resolve => { releaseFirst = resolve; });
    let enteredFirst: () => void = () => undefined;
    const firstEntered = new Promise<void>(resolve => { enteredFirst = resolve; });
    const first = store.update(root, async runs => {
      enteredFirst();
      await firstPaused;
      return [...runs, { id: "first", status: "running", startedAt: "now" }];
    });
    await firstEntered;
    const second = store.update(root, runs => [...runs, { id: "second", status: "running", startedAt: "now" }]);
    releaseFirst();
    await Promise.all([first, second]);

    expect((await store.load(root)).map(run => run.id)).toEqual(["first", "second"]);
  });

  it("does not let a stale reconciler save replace an already-persisted terminal run", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    const running = { id: "first", status: "running" as const, startedAt: "now", pid: 123 };
    await store.save(root, [running]);
    const reconcilerSnapshot = await store.load(root);
    const completed = { ...running, status: "completed" as const, completedAt: "later" };
    await store.update(root, runs => runs.map(run => run.id === running.id ? completed : run));
    await store.save(root, reconcilerSnapshot.map(run => ({ ...run, status: "failed", error: "process exited" })));

    expect(await store.load(root)).toEqual([completed]);
  });

  it("keeps runs appended since a reconciler read its snapshot", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    const first = { id: "first", status: "running" as const, startedAt: "now" };
    const second = { id: "second", status: "starting" as const, startedAt: "later" };
    await store.save(root, [first]);
    const snapshot = await store.load(root);
    await store.update(root, runs => [...runs, second]);
    await store.save(root, snapshot.map(run => ({ ...run, status: "failed", error: "process exited" })));

    expect(await store.load(root)).toEqual([{ ...first, status: "failed", error: "process exited" }, second]);
  });

  it("does not apply a stale starting failure after a process pid is recorded", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    const starting = { id: "first", status: "starting" as const, startedAt: "now" };
    await store.save(root, [starting]);
    const snapshot = await store.load(root);
    const running = { ...starting, status: "running" as const, pid: 123 };
    await store.update(root, () => [running]);
    await store.save(root, snapshot.map(run => ({ ...run, status: "failed", error: "process exited" })));

    expect(await store.load(root)).toEqual([running]);
  });

  it("continues processing queued updates after an updater fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-work-item-run-store-"));
    const store = createWorkItemRunStore({ resolveWorkspace: value => value });
    const failure = store.update(root, () => { throw new Error("write failed"); });
    const next = store.update(root, runs => [...runs, { id: "next", status: "running", startedAt: "now" }]);

    await expect(failure).rejects.toThrow("write failed");
    await next;
    expect((await store.load(root)).map(run => run.id)).toEqual(["next"]);
  });
});
