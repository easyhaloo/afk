import { queryProviderInventory } from "@afk/application";
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
};

export type WorkItemApplicationAdapter = {
  list: (options?: WorkItemInventoryOptions) => Promise<WorkItemInventoryResult>;
};

type WorkItemApplicationProviderDeps = {
  loadSnapshot: (platform: "github" | "gitlab" | "all") => Promise<WorkItemInventoryResult>;
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
function loadProviderSnapshot(platform: "github" | "gitlab" | "all"): Promise<WorkItemInventoryResult> {
  const bundle = path.join(app.getAppPath(), "dist-electron/provider-inventory.cjs");
  const provider = requireCjs(bundle) as {
    collectProviderInventory: (platform: "github" | "gitlab" | "all") => Promise<WorkItemInventoryResult>;
  };
  return provider.collectProviderInventory(platform);
}

export function createProviderWorkItemApplicationFacade(deps: WorkItemApplicationProviderDeps = { loadSnapshot: loadProviderSnapshot }): WorkItemApplicationFacade {
  return {
    async listWorkItems(options) {
      return parseWorkItemInventoryResult(await queryProviderInventory(options, {
        list: deps.loadSnapshot,
      }));
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
  };
}
