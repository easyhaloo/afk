import type { WorkItemApplicationAdapter } from "../adapters/work-item-application-adapter";
import {
  parseWorkItemInventoryOptions,
  type WorkItemInventoryOptions,
  type WorkItemInventoryResult,
} from "../../shared/backlog-contract";
import { workItemInventoryKey, type WorkItemInventoryStore } from "./work-item-inventory-store";

export type WorkItemInventoryServiceDeps = {
  application: WorkItemApplicationAdapter;
  store?: WorkItemInventoryStore;
  staleAfterMs?: number;
};

export function createWorkItemInventoryService(deps: WorkItemInventoryServiceDeps) {
  const cache = new Map<string, WorkItemInventoryResult>();
  const syncedAt = new Map<string, number>();
  const refreshes = new Map<string, Promise<WorkItemInventoryResult>>();
  const staleAfterMs = deps.staleAfterMs ?? 5 * 60 * 1000;

  return {
    async list(rawOptions?: WorkItemInventoryOptions, force = false): Promise<WorkItemInventoryResult> {
      const options = parseWorkItemInventoryOptions(rawOptions);
      const key = workItemInventoryKey(options);
      if (force) cache.delete(key);
      if (!force && cache.has(key)) {
        if (isStale(syncedAt.get(key), staleAfterMs)) refreshInBackground(options);
        return cache.get(key)!;
      }
      if (!force && deps.store) {
        const stored = await deps.store.read(options);
        if (stored) {
          cache.set(key, stored.inventory);
          syncedAt.set(key, Date.parse(stored.syncedAt));
          if (isStale(syncedAt.get(key), staleAfterMs)) refreshInBackground(options);
          return stored.inventory;
        }
        if (options.platform && options.platform !== "all") {
          const completeInventory = await deps.store.read({});
          if (completeInventory) {
            const projected = projectInventory(completeInventory.inventory, options.platform);
            cache.set(key, projected);
            syncedAt.set(key, Date.parse(completeInventory.syncedAt));
            if (isStale(syncedAt.get(key), staleAfterMs)) refreshInBackground({});
            return projected;
          }
        }
      }
      return refresh(options);
    },
    async sync(rawOptions?: WorkItemInventoryOptions): Promise<WorkItemInventoryResult> {
      return refresh(parseWorkItemInventoryOptions(rawOptions));
    },
    invalidate(): void {
      cache.clear();
      syncedAt.clear();
    },
  };

  async function refresh(options: WorkItemInventoryOptions): Promise<WorkItemInventoryResult> {
    const key = workItemInventoryKey(options);
    const inflight = refreshes.get(key);
    if (inflight) return inflight;
    const request = fetchRemote(options).then(async inventory => {
      if (inventory.complete) {
        const timestamp = new Date().toISOString();
        if (inventory.items.length > 0 || deps.store) cache.set(key, inventory);
        else cache.delete(key);
        syncedAt.set(key, Date.parse(timestamp));
        if (deps.store) await deps.store.write({ options, inventory, syncedAt: timestamp }).catch(() => undefined);
      } else {
        cache.delete(key);
        syncedAt.delete(key);
      }
      return inventory;
    }).finally(() => {
      refreshes.delete(key);
    });
    refreshes.set(key, request);
    return request;
  }

  function refreshInBackground(options: WorkItemInventoryOptions): void {
    void refresh(options).catch(() => undefined);
  }

  async function fetchRemote(options: WorkItemInventoryOptions): Promise<WorkItemInventoryResult> {
    return deps.application.list(options);
  }
}

function isStale(timestamp: number | undefined, staleAfterMs: number): boolean {
  return timestamp === undefined || !Number.isFinite(timestamp) || Date.now() - timestamp >= staleAfterMs;
}

function projectInventory(inventory: WorkItemInventoryResult, platform: "github" | "gitlab"): WorkItemInventoryResult {
  const items = inventory.items.filter(item => item.sources?.some(source => source.platform === platform) ?? item.project.platform === platform);
  return {
    ...inventory,
    items,
    projects: inventory.projects.filter(project => project.platform === platform),
    diagnostics: inventory.diagnostics.filter(diagnostic => diagnostic.platform === platform),
  };
}
