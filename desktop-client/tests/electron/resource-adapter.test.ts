import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createResourceAdapter } from "../../electron/adapters/resource-adapter";

describe("AFK resource adapter", () => {
  it("returns only resources scoped to the selected project and preserves their actual workspace", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "afk-resource-scope-"));
    const selected = path.join(root, "checkout");
    const task = path.join(root, "github", "easyhaloo", "afk", "144");
    const other = path.join(root, "github", "elsewhere", "afk", "99");
    const resources = [
      { id: "resource-144", resourceKey: "resource-144", workspacePath: task, kind: "tmux" as const, origin: "local-sandbox" as const, engine: undefined, name: "afk-github:easyhaloo/afk#144-verify-ac", externalId: undefined, detail: undefined, status: "active" as const, worktreePath: "", runId: "run-144", createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z", metadata: {} },
      { id: "resource-99", resourceKey: "resource-99", workspacePath: other, kind: "tmux" as const, origin: "local-sandbox" as const, engine: undefined, name: "unrelated-session", externalId: undefined, detail: undefined, status: "active" as const, worktreePath: "", runId: undefined, createdAt: "2026-09-20T08:00:00.000Z", updatedAt: "2026-09-20T08:00:00.000Z", metadata: {} },
    ];
    const adapter = createResourceAdapter({ readResources: () => resources, executable: async () => "/usr/bin/tmux", exec: async (_command, args) => ({
      ok: args[args.indexOf("-t") + 1] !== "unrelated-session", stdout: "1\t0", stderr: "",
    }) });

    expect(await adapter.listAfkTmux([selected, task])).toEqual([{
      workspace: task, name: "afk-github:easyhaloo/afk#144-verify-ac", windows: "1", attached: false, runId: "run-144", resourceId: "resource-144",
    }]);
    expect(adapter.isAfkTmuxSession([selected, task], "unrelated-session", task)).toBe(false);
    expect(adapter.isAfkTmuxSession([selected, task], "afk-github:easyhaloo/afk#144-verify-ac", task)).toBe(true);
    expect(adapter.isAfkTmuxSession([selected, task], "afk-github:easyhaloo/afk#144-verify-ac", selected)).toBe(false);
  });
});
