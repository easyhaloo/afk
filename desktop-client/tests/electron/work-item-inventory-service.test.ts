import { describe, expect, it, vi } from "vitest";
import { createWorkItemApplicationAdapter } from "../../electron/adapters/work-item-application-adapter";
import { createWorkItemInventoryService } from "../../electron/services/work-item-inventory-service";

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
