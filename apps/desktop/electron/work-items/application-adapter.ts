import { queryProviderInventory } from "@afk/application";
import type { ProviderAccountIdentity } from "@afk/runtime/domain/work-item/provider-types";
import { app } from "electron";
import {
  parseWorkItemInventoryOptions,
  parseWorkItemInventoryResult,
  type WorkItemInventoryOptions,
  type WorkItemInventoryResult,
} from "../../shared/backlog-contract.js";
import { createRequire } from "node:module";
import path from "node:path";

export type WorkItemApplicationFacade = {
  listWorkItems: (options: WorkItemInventoryOptions) => Promise<WorkItemInventoryResult>;
  getAccountIdentities: () => Promise<ProviderAccountIdentity[]>;
};

export type WorkItemApplicationAdapter = {
  list: (options?: WorkItemInventoryOptions) => Promise<WorkItemInventoryResult>;
  getAccountIdentities: () => Promise<ProviderAccountIdentity[]>;
};

type WorkItemApplicationProviderDeps = {
  loadSnapshot: (platform: "github" | "gitlab" | "all") => Promise<WorkItemInventoryResult | { inventory: WorkItemInventoryResult; identities: ProviderAccountIdentity[] }>;
  loadIdentities?: () => Promise<ProviderAccountIdentity[]>;
};

const requireCjs = createRequire(import.meta.url);

// The provider snapshot is a real bundle (it inlines the GitHub/GitLab SDKs),
// emitted as dist-electron/provider-inventory.cjs. It is genuine CommonJS, so it
// is loaded through createRequire.
//
// The path comes from the app root, not from this module's location: main.js is
// a bundle, so every inlined module shares one URL and module-relative depth
// no longer means anything. getAppPath() resolves to the app dir in development
// and the asar root once packaged.
function loadProviderSnapshot(platform: "github" | "gitlab" | "all"): Promise<WorkItemInventoryResult | { inventory: WorkItemInventoryResult; identities: ProviderAccountIdentity[] }> {
  const bundle = path.join(app.getAppPath(), "dist-electron/provider-inventory.cjs");
  const provider = requireCjs(bundle) as {
    collectProviderInventorySnapshot?: (platform: "github" | "gitlab" | "all") => Promise<{ inventory: WorkItemInventoryResult; identities: ProviderAccountIdentity[] }>;
    collectProviderInventory: (platform: "github" | "gitlab" | "all") => Promise<WorkItemInventoryResult>;
  };
  return provider.collectProviderInventorySnapshot?.(platform) ?? provider.collectProviderInventory(platform);
}

function loadProviderIdentities(): Promise<ProviderAccountIdentity[]> {
  const bundle = path.join(app.getAppPath(), "dist-electron/provider-inventory.cjs");
  const provider = requireCjs(bundle) as {
    getProviderAccountIdentities?: () => Promise<ProviderAccountIdentity[]>;
  };
  if (!provider.getProviderAccountIdentities) throw new Error("Verified Provider account identity is unavailable");
  return provider.getProviderAccountIdentities();
}

export function createProviderWorkItemApplicationFacade(deps: WorkItemApplicationProviderDeps = { loadSnapshot: loadProviderSnapshot, loadIdentities: loadProviderIdentities }): WorkItemApplicationFacade {
  let lastIdentities: ProviderAccountIdentity[] | undefined;
  return {
    async listWorkItems(options) {
      const loaded = await deps.loadSnapshot(options.platform ?? "all");
      if ("inventory" in loaded) lastIdentities = loaded.identities;
      const snapshot = "inventory" in loaded ? loaded.inventory : loaded;
      return parseWorkItemInventoryResult(await queryProviderInventory(options, { list: async () => snapshot }));
    },
    async getAccountIdentities() {
      if (lastIdentities) return lastIdentities;
      if (deps.loadIdentities) {
        lastIdentities = await deps.loadIdentities();
        return lastIdentities;
      }
      const loaded = await deps.loadSnapshot("all");
      if (!("inventory" in loaded)) throw new Error("Verified Provider account identity is unavailable");
      lastIdentities = loaded.identities;
      return loaded.identities;
    },
  };
}

export function createWorkItemApplicationAdapter(
  facade: WorkItemApplicationFacade,
): WorkItemApplicationAdapter {
  return {
    async list(rawOptions = {}) {
      const options = parseWorkItemInventoryOptions(rawOptions);
      return parseWorkItemInventoryResult(await facade.listWorkItems(options));
    },
    getAccountIdentities: facade.getAccountIdentities,
  };
}
