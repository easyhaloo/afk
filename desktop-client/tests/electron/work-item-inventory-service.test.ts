import { describe, expect, it, vi } from "vitest";
import { createWorkItemInventoryService } from "../../electron/services/work-item-inventory-service";

const inventory = {
  items: [
    {
      id: "github:acme/api#1",
      issueNumber: 1,
      project: { platform: "github", projectKey: "acme/api", name: "api" },
      title: "API issue",
      managed: true,
      executionEligible: true,
      state: "ready",
      executionMode: "afk",
      dependsOn: [],
      tags: [],
      branchName: "afk/backlog-1",
      providerRef: "github:acme/api#1",
    },
  ],
  projects: [{ platform: "github", projectKey: "acme/api", name: "api" }],
  diagnostics: [],
  complete: true,
};

describe("work item inventory service", () => {
  it("invokes the global inventory command without a source workspace", async () => {
    const exec = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ ok: true, kind: "backlog.inventory", data: inventory }),
      stderr: "",
    }));
    const service = createWorkItemInventoryService({
      resolveAfk: async () => ({ command: "/usr/local/bin/afk", args: [] }),
      cwd: "/tmp/afk-control",
      exec,
    });

    await expect(service.list({ platform: "all" })).resolves.toEqual(inventory);
    expect(exec).toHaveBeenCalledWith(
      "/usr/local/bin/afk",
      ["backlog", "inventory", "--platform", "all", "--json"],
      "/tmp/afk-control",
    );
  });

  it("preserves successful items when the inventory is partial", async () => {
    const partial = {
      ...inventory,
      diagnostics: [{ platform: "gitlab", projectKey: "corp/tools", code: "auth", message: "token expired", retryable: true }],
      complete: false,
    };
    const service = createWorkItemInventoryService({
      resolveAfk: async () => ({ command: process.execPath, args: ["/repo/dist/index.js"] }),
      cwd: "/tmp/afk-control",
      exec: async () => ({ ok: true, stdout: JSON.stringify({ ok: true, kind: "backlog.inventory", data: partial }), stderr: "" }),
    });

    const result = await service.list();
    expect(result.items).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.diagnostics[0].projectKey).toBe("corp/tools");
  });

  it("bypasses a cached result on forced refresh", async () => {
    let count = 0;
    const exec = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({ ok: true, kind: "backlog.inventory", data: { ...inventory, items: count++ ? [] : inventory.items } }),
      stderr: "",
    }));
    const service = createWorkItemInventoryService({
      resolveAfk: async () => ({ command: "/usr/local/bin/afk", args: [] }),
      cwd: "/tmp/afk-control",
      exec,
    });

    expect((await service.list()).items).toHaveLength(1);
    expect((await service.list()).items).toHaveLength(1);
    expect((await service.list(undefined, true)).items).toHaveLength(0);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("uses the bundled inventory runner when the packaged app has no afk executable", async () => {
    const runBundled = vi.fn(async () => inventory);
    const exec = vi.fn();
    const service = createWorkItemInventoryService({
      resolveAfk: async () => ({ command: "", args: [] }),
      runBundled,
      cwd: "/tmp/afk-control",
      exec,
    });

    await expect(service.list({ platform: "github" })).resolves.toEqual(inventory);
    expect(runBundled).toHaveBeenCalledWith({ platform: "github" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not retain empty or partial inventory results in the automatic cache", async () => {
    let count = 0;
    const exec = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        ok: true,
        kind: "backlog.inventory",
        data: count++ === 0
          ? { items: [], projects: [], diagnostics: [], complete: true }
          : inventory,
      }),
      stderr: "",
    }));
    const service = createWorkItemInventoryService({
      resolveAfk: async () => ({ command: "/usr/local/bin/afk", args: [] }),
      cwd: "/tmp/afk-control",
      exec,
    });

    expect((await service.list()).items).toHaveLength(0);
    expect((await service.list()).items).toHaveLength(1);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
