import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { AfkResourceRecord } from "@afk/core";
import { createResourceAdapter } from "../../electron/adapters/resource-adapter";

const row = (overrides: Partial<AfkResourceRecord> = {}): AfkResourceRecord => ({
  id: "resource-144",
  resourceKey: "resource-144",
  workspacePath: "/workspace",
  kind: "tmux",
  origin: "local-sandbox",
  name: "afk-run",
  status: "active",
  worktreePath: "/workspace/.afk/worktrees/run-144",
  createdAt: "2026-09-20T08:00:00.000Z",
  updatedAt: "2026-09-20T08:00:00.000Z",
  metadata: {},
  ...overrides,
});

describe("AFK resource adapter", () => {
  it("returns only resources scoped to the selected project and preserves their actual workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-resource-scope-"));
    const selected = path.join(root, "checkout");
    const task = path.join(root, "github", "easyhaloo", "afk", "144");
    const other = path.join(root, "github", "elsewhere", "afk", "99");
    const resources = [
      row({ id: "resource-144", resourceKey: "resource-144", workspacePath: task, name: "afk-github:easyhaloo/afk#144-verify-ac", runId: "run-144" }),
      row({ id: "resource-99", resourceKey: "resource-99", workspacePath: other, name: "unrelated-session" }),
    ];
    const adapter = createResourceAdapter({
      registry: { readActive: () => [], readRun: () => [] },
      readResources: () => resources,
      executable: async () => "/usr/bin/tmux",
      exec: async (_command, args) => ({
        ok: args[args.indexOf("-t") + 1] !== "unrelated-session", stdout: "1\t0", stderr: "",
      }),
    });

    expect(await adapter.listAfkTmux([selected, task])).toEqual([{
      workspace: task, name: "afk-github:easyhaloo/afk#144-verify-ac", windows: "1", attached: false, runId: "run-144", resourceId: "resource-144",
    }]);
    expect(adapter.isAfkTmuxSession([selected, task], "unrelated-session", task)).toBe(false);
    expect(adapter.isAfkTmuxSession([selected, task], "afk-github:easyhaloo/afk#144-verify-ac", task)).toBe(true);
    expect(adapter.isAfkTmuxSession([selected, task], "afk-github:easyhaloo/afk#144-verify-ac", selected)).toBe(false);
  });

  it("reads the registered resources through the runtime's port", async () => {
    const asked: string[][] = [];
    const adapter = createResourceAdapter({
      registry: {
        readActive: (workspaces) => {
          asked.push([...workspaces]);
          return [row({ name: "afk-run" })];
        },
        readRun: (runId) => [row({ id: `resource-${runId}`, resourceKey: `resource-${runId}`, runId })],
      },
      executable: async () => "/usr/bin/tmux",
      exec: async () => ({ ok: true, stdout: "2\t1", stderr: "" }),
    });

    expect(await adapter.listAfkTmux(["/workspace"])).toEqual([
      { workspace: "/workspace", name: "afk-run", windows: "2", attached: true, resourceId: "resource-144" },
    ]);
    expect(asked).toEqual([["/workspace"]]);
    expect(adapter.listRunResources("run-1").map((resource) => resource.id)).toEqual(["resource-run-1"]);
  });
});
