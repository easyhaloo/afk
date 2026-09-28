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
      { workspace_path: task, kind: "tmux" as const, origin: "local-sandbox" as const, engine: null, name: "afk-github:easyhaloo/afk#144-verify-ac", external_id: null, detail: null },
      { workspace_path: other, kind: "tmux" as const, origin: "local-sandbox" as const, engine: null, name: "unrelated-session", external_id: null, detail: null },
    ];
    const adapter = createResourceAdapter({ readResources: () => resources, executable: async () => "/usr/bin/tmux", exec: async (_command, args) => ({
      ok: args[args.indexOf("-t") + 1] !== "unrelated-session", stdout: "1\t0", stderr: "",
    }) });

    expect(await adapter.listAfkTmux([selected, task])).toEqual([{
      workspace: task, name: "afk-github:easyhaloo/afk#144-verify-ac", windows: "1", attached: false,
    }]);
    expect(adapter.isAfkTmuxSession([selected, task], "unrelated-session", task)).toBe(false);
    expect(adapter.isAfkTmuxSession([selected, task], "afk-github:easyhaloo/afk#144-verify-ac", task)).toBe(true);
    expect(adapter.isAfkTmuxSession([selected, task], "afk-github:easyhaloo/afk#144-verify-ac", selected)).toBe(false);
  });
});
