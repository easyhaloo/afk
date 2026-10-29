import type { WorkItemApplicationAdapter } from "./application-adapter.js";
import { listWorkItemChildren } from "@afk/runtime/application/work-item/children";
import {
  parseWorkItemInventoryOptions,
  type GlobalWorkItem,
  type WorkItemChildrenResult,
  type WorkItemInventoryOptions,
  type WorkItemInventoryResult,
} from "../../shared/backlog-contract.js";
import { workItemInventoryKey, type WorkItemInventoryStore } from "./inventory-store.js";

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
    /**
     * The issues that belong to one work item.
     *
     * The children may live in other repositories than the parent, so the
     * answer comes from the whole inventory rather than from one project.
     * A copy that has gone stale is collected again before the question is
     * answered, so a PRD that was split after the last collection still
     * reports its children.
     */
    async children(workItemId: string): Promise<WorkItemChildrenResult> {
      const options: WorkItemInventoryOptions = {};
      const key = workItemInventoryKey(options);
      const inventory = await this.list(options);
      const stale = isStale(syncedAt.get(key), staleAfterMs);
      return listWorkItemChildren<GlobalWorkItem>({
        read: async () => ({ items: inventory.items, stale }),
        refresh: async () => ({ items: (await this.sync(options)).items }),
      }, { parentId: workItemId });
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
      const timestamp = new Date().toISOString();
      if (inventory.items.length > 0 || deps.store || !inventory.complete) cache.set(key, inventory);
      else cache.delete(key);
      syncedAt.set(key, Date.parse(timestamp));
      if (inventory.complete && deps.store) await deps.store.write({ options, inventory, syncedAt: timestamp }).catch(() => undefined);
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
