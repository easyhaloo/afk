import {
  parseWorkItemInventoryOptions,
  parseWorkItemInventoryResult,
  type WorkItemInventoryOptions,
  type WorkItemInventoryResult,
} from "../../shared/backlog-contract";
import { join } from "node:path";
import { loadApplication } from "./application-module";

export type WorkItemApplicationFacade = {
  listWorkItems: (options: WorkItemInventoryOptions) => Promise<WorkItemInventoryResult>;
};

export type WorkItemApplicationAdapter = {
  list: (options?: WorkItemInventoryOptions) => Promise<WorkItemInventoryResult>;
};

type WorkItemApplicationProviderDeps = {
  loadSnapshot: (platform: "github" | "gitlab" | "all") => Promise<WorkItemInventoryResult>;
};

function loadProviderSnapshot(platform: "github" | "gitlab" | "all"): Promise<WorkItemInventoryResult> {
  const provider = require(join(__dirname, "..", "..", "provider-inventory.cjs")) as {
    collectProviderInventory: (platform: "github" | "gitlab" | "all") => Promise<WorkItemInventoryResult>;
  };
  return provider.collectProviderInventory(platform);
}

export function createProviderWorkItemApplicationFacade(deps: WorkItemApplicationProviderDeps = { loadSnapshot: loadProviderSnapshot }): WorkItemApplicationFacade {
  return {
    async listWorkItems(options) {
      const application = loadApplication();
      return parseWorkItemInventoryResult(await application.queryProviderInventory(options, {
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
