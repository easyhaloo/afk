import { describe, expect, it, vi } from "vitest";
import { createWorkItemApplicationAdapter } from "../../electron/work-items/application-adapter.js";
import { createWorkItemInventoryService } from "../../electron/work-items/inventory-service.js";

const inventory = {
  items: [{
    id: "github:acme/api#1",
    issueNumber: 1,
    project: { platform: "github" as const, projectKey: "acme/api", name: "api" },
    title: "API issue",
    managed: true,
    executionEligible: true,
    state: "ready" as const,
    executionMode: "afk" as const,
    dependsOn: [],
    tags: [],
    branchName: "afk/backlog-1",
    providerRef: "github:acme/api#1",
  }],
  projects: [{ platform: "github" as const, projectKey: "acme/api", name: "api" }],
  diagnostics: [],
  complete: true,
};

function application(value = inventory) {
  return createWorkItemApplicationAdapter({
    listWorkItems: vi.fn(async () => value),
  });
}

describe("work item inventory service", () => {
  it("uses the required application boundary", async () => {
    const listWorkItems = vi.fn(async () => inventory);
    const service = createWorkItemInventoryService({
      application: createWorkItemApplicationAdapter({ listWorkItems }),
    });

    await expect(service.list({ platform: "github" })).resolves.toEqual(inventory);
    expect(listWorkItems).toHaveBeenCalledWith({ platform: "github" });
  });

  it("caches complete results and bypasses the cache on forced refresh", async () => {
    let count = 0;
    const service = createWorkItemInventoryService({
      application: createWorkItemApplicationAdapter({
        listWorkItems: vi.fn(async () => ({ ...inventory, items: count++ ? [] : inventory.items })),
      }),
    });

    expect((await service.list()).items).toHaveLength(1);
    expect((await service.list()).items).toHaveLength(1);
    expect((await service.list(undefined, true)).items).toHaveLength(0);
  });

  it("preserves successful items when the application reports partial inventory", async () => {
    const partial = {
      ...inventory,
      diagnostics: [{ platform: "gitlab" as const, projectKey: "corp/tools", code: "auth", message: "token expired", retryable: true }],
      complete: false,
    };
    const service = createWorkItemInventoryService({ application: application(partial) });

    const result = await service.list();
    expect(result.items).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.diagnostics[0].projectKey).toBe("corp/tools");
  });

  it("caches partial results in memory during polling and permits a forced retry", async () => {
    const partial = { ...inventory, complete: false, diagnostics: [{ platform: "github" as const,
      projectKey: "acme/blocked", code: "forbidden", message: "Repository access blocked", retryable: false }] };
    const listWorkItems = vi.fn().mockResolvedValueOnce(partial).mockResolvedValue(inventory);
    const store = { read: vi.fn(async () => null), write: vi.fn(async () => undefined), clear: vi.fn() };
    const service = createWorkItemInventoryService({ application: createWorkItemApplicationAdapter({ listWorkItems }), store });

    await expect(service.list()).resolves.toEqual(partial);
    await expect(service.list()).resolves.toEqual(partial);
    expect(listWorkItems).toHaveBeenCalledTimes(1);
    expect(store.write).not.toHaveBeenCalled();
    await expect(service.list(undefined, true)).resolves.toEqual(inventory);
    expect(listWorkItems).toHaveBeenCalledTimes(2);
    expect(store.write).toHaveBeenCalledTimes(1);
  });

  it("returns a persisted snapshot without invoking the application", async () => {
    const listWorkItems = vi.fn(async () => inventory);
    const app = createWorkItemApplicationAdapter({ listWorkItems });
    const store = {
      read: vi.fn(async () => ({ options: {}, inventory, syncedAt: new Date().toISOString() })),
      write: vi.fn(),
      clear: vi.fn(),
    };
    const service = createWorkItemInventoryService({ application: app, store });

    await expect(service.list()).resolves.toEqual(inventory);
    expect(store.read).toHaveBeenCalledWith({});
    expect(listWorkItems).not.toHaveBeenCalled();
  });

  it("projects a complete snapshot for provider filters", async () => {
    const store = {
      read: vi.fn(async (options: { platform?: string }) => options.platform
        ? null
        : {
          options: {},
          inventory: {
            ...inventory,
            items: [
              inventory.items[0],
              { ...inventory.items[0], id: "gitlab:corp/tools#2", project: { platform: "gitlab" as const, projectKey: "corp/tools", name: "tools" } },
            ],
            projects: [
              inventory.projects[0],
              { platform: "gitlab" as const, projectKey: "corp/tools", name: "tools" },
            ],
          },
          syncedAt: new Date().toISOString(),
        }),
      write: vi.fn(),
      clear: vi.fn(),
    };
    const service = createWorkItemInventoryService({ application: application(), store });

    const result = await service.list({ platform: "gitlab" });

    expect(result.items.map(item => item.id)).toEqual(["gitlab:corp/tools#2"]);
    expect(store.read).toHaveBeenCalledWith({});
  });
});

describe("work item children", () => {
  const parent = {
    ...inventory.items[0],
    id: "gitlab:corp/req#7",
    issueNumber: 7,
    project: { platform: "gitlab" as const, projectKey: "corp/req", name: "req" },
    title: "the PRD",
    state: "prd" as const,
  };
  const child = {
    ...inventory.items[0],
    id: "gitlab:corp/svc#8",
    issueNumber: 8,
    project: { platform: "gitlab" as const, projectKey: "corp/svc", name: "svc" },
    title: "child issue",
    parentId: parent.id,
  };

  it("lists the issues that belong to one work item", async () => {
    const service = createWorkItemInventoryService({
      application: application({ ...inventory, items: [parent, child] }),
    });

    const result = await service.children(parent.id);

    expect(result.parent.id).toBe(parent.id);
    expect(result.children.map(entry => entry.id)).toEqual([child.id]);
    expect(result.source).toBe("inventory");
  });

  it("reports a work item that does not exist", async () => {
    const service = createWorkItemInventoryService({
      application: application({ ...inventory, items: [parent, child] }),
    });

    await expect(service.children("gitlab:corp/req#404")).rejects.toThrow(/not found/i);
  });
});
