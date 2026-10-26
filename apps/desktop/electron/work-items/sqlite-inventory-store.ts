import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { inventoryNamespace, SqliteInventoryStore } from "@afk/runtime/storage";
import type { ProviderAccountIdentity } from "@afk/runtime/domain/work-item/provider-types";
import { parseWorkItemInventoryOptions, parseWorkItemInventoryResult, type WorkItemInventoryOptions, type WorkItemInventoryResult } from "../../shared/backlog-contract.js";
import type { StoredWorkItemInventory, WorkItemInventoryStore } from "./inventory-store.js";
import type { InventoryDiagnostic, InventoryItem, InventoryProject, InventorySnapshot } from "@afk/application";

type SqliteWorkItemInventoryStoreOptions = {
  getAccountIdentities: () => Promise<ProviderAccountIdentity[]>;
  root?: string;
  legacyFile?: string;
};

export type SqliteWorkItemInventoryStore = WorkItemInventoryStore & { close: () => void };

export function createSqliteWorkItemInventoryStore(options: SqliteWorkItemInventoryStoreOptions): SqliteWorkItemInventoryStore {
  let storePromise: Promise<SqliteInventoryStore> | undefined;
  let identitiesPromise: Promise<ProviderAccountIdentity[]> | undefined;
  let namespaceKey: string | undefined;

  function getIdentities() {
    if (!identitiesPromise) identitiesPromise = options.getAccountIdentities();
    return identitiesPromise;
  }

  async function getStore(): Promise<SqliteInventoryStore> {
    if (!storePromise) {
      storePromise = getIdentities().then(async identities => {
        if (!identities.length) throw new Error("Verified Provider account identity is unavailable");
        namespaceKey = inventoryNamespace(identities);
        const store = new SqliteInventoryStore({ root: options.root, namespaceKey });
        if (options.legacyFile) await importLegacyInventory(store, identities, options.legacyFile);
        return store;
      });
    }
    return storePromise;
  }

  return {
    async read(rawOptions) {
      const store = await getStore();
      const query = await store.query(rawOptions);
      const projects = await store.repositories({ platform: rawOptions.platform, limit: 200 });
      if (!query.lastSuccessAt && !query.items.length && !projects.items.length && !query.diagnostics.length) return null;
      return {
        options: rawOptions,
        inventory: {
          items: query.items as unknown as WorkItemInventoryResult["items"],
          projects: projects.items as unknown as WorkItemInventoryResult["projects"],
          diagnostics: query.diagnostics as unknown as WorkItemInventoryResult["diagnostics"],
          complete: query.complete,
        },
        syncedAt: query.lastSuccessAt ? new Date(query.lastSuccessAt).toISOString() : new Date(0).toISOString(),
      } satisfies StoredWorkItemInventory;
    },
    async write(entry) {
      const store = await getStore();
      const identities = await options.getAccountIdentities();
      if (!namespaceKey || inventoryNamespace(identities) !== namespaceKey) throw new Error("Provider account identity changed; restart the Desktop client before refreshing inventory");
      await publishEntry(store, identities, entry);
    },
    async clear() {
      await (await getStore()).clear();
    },
    close() {
      void storePromise?.then(store => store.close());
    },
  };
}

async function publishEntry(store: SqliteInventoryStore, identities: readonly ProviderAccountIdentity[], entry: StoredWorkItemInventory): Promise<void> {
  for (const identity of identities) {
    if (entry.options.platform && entry.options.platform !== "all" && entry.options.platform !== identity.platform) continue;
    const projects = entry.inventory.projects.filter(project => project.platform === identity.platform && (project.providerHost ?? identity.host) === identity.host);
    const projectKeys = new Set(projects.map(project => project.projectKey));
    const items = entry.inventory.items.filter(item => item.project.platform === identity.platform && (item.project.providerHost ?? identity.host) === identity.host);
    const diagnostics = entry.inventory.diagnostics.filter(diagnostic => diagnostic.platform === identity.platform && (!diagnostic.projectKey || diagnostic.projectKey === identity.host || projectKeys.has(diagnostic.projectKey)));
    const attempt = await store.begin({ platform: identity.platform, host: identity.host, kind: "catalog" });
    await store.publish(attempt, {
      items: items as unknown as InventoryItem[],
      projects: projects as unknown as InventoryProject[],
      diagnostics: diagnostics as unknown as InventoryDiagnostic[],
      complete: entry.inventory.complete && diagnostics.length === 0,
    } satisfies InventorySnapshot);
  }
}

async function importLegacyInventory(store: SqliteInventoryStore, identities: readonly ProviderAccountIdentity[], file: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const sourceKey = `legacy:inventory:${path.resolve(file)}`;
  if (await store.hasLegacyImport(sourceKey)) return;
  const sourceSha256 = createHash("sha256").update(content).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("Legacy work item inventory is corrupted");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed as Record<string, unknown>).version !== 1 || !isRecord((parsed as Record<string, unknown>).entries)) {
    throw new Error("Legacy work item inventory is corrupted");
  }
  const entries = Object.values((parsed as Record<string, unknown>).entries as Record<string, unknown>).map(value => parseLegacyEntry(value));
  for (const entry of entries) await publishEntry(store, identities, entry);
  await store.recordLegacyImport(sourceKey, sourceSha256, entries.reduce((total, entry) => total + entry.inventory.items.length, 0));
}

function parseLegacyEntry(value: unknown): StoredWorkItemInventory {
  if (!isRecord(value) || typeof value.syncedAt !== "string") throw new Error("Legacy work item inventory is corrupted");
  return {
    options: parseWorkItemInventoryOptions(value.options),
    inventory: parseWorkItemInventoryResult(value.inventory),
    syncedAt: value.syncedAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
