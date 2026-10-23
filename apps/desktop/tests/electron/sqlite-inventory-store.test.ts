import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createSqliteWorkItemInventoryStore } from "../../electron/work-items/sqlite-inventory-store.js";

describe("SQLite work item inventory adapter", () => {
  it("uses the verified account namespace and round-trips inventory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-desktop-inventory-adapter-"));
    const store = createSqliteWorkItemInventoryStore({
      root,
      getAccountIdentities: async () => [{ platform: "github", host: "github.com", accountId: "42" }],
    });
    const entry = {
      options: {},
      inventory: {
        items: [{
          id: "github:acme/api#1",
          issueNumber: 1,
          project: { platform: "github" as const, projectKey: "acme/api", name: "api", defaultBranch: "main" },
          title: "API issue",
          managed: true,
          executionEligible: true,
          state: "ready" as const,
          executionMode: "afk" as const,
          dependsOn: [],
          tags: ["urgent"],
          branchName: "afk/backlog-1",
          providerRef: "github:acme/api#1",
        }],
        projects: [{ platform: "github" as const, projectKey: "acme/api", name: "api", defaultBranch: "main" }],
        diagnostics: [],
        complete: true,
      },
      syncedAt: new Date().toISOString(),
    };

    await store.write(entry);
    await expect(store.read({})).resolves.toMatchObject({ inventory: { items: [{ id: entry.inventory.items[0].id }] } });
    await store.clear();
    await expect(store.read({})).resolves.toBeNull();
    store.close();
  });

  it("imports the legacy JSON once and keeps the source file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "afk-desktop-inventory-migration-"));
    const legacyFile = path.join(root, "work-item-inventory.json");
    const inventory = {
      items: [],
      projects: [],
      diagnostics: [],
      complete: true,
    };
    await writeFile(legacyFile, JSON.stringify({ version: 1, entries: { all: { options: {}, inventory, syncedAt: "2026-10-22T00:00:00.000Z" } } }));
    const store = createSqliteWorkItemInventoryStore({
      root,
      legacyFile,
      getAccountIdentities: async () => [{ platform: "github", host: "github.com", accountId: "42" }],
    });

    const migrated = await store.read({});
    const restored = await store.read({});
    expect(migrated?.inventory.complete).toBe(true);
    expect(migrated?.syncedAt).toBe(restored?.syncedAt);
    store.close();
  });
});
