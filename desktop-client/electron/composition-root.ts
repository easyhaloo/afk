import type { WorkItemPlatform } from "@afk/application";
import type { ExecuteWorkItemStatus } from "@afk/execution";
import { createRequire } from "node:module";
import { app } from "electron";
import path from "node:path";
import type { BacklogManagementProvider } from "@afk/application";
import type { ManagementProviderBundle } from "@afk/infrastructure";
import { fileConfigurationPort } from "@afk/execution/infrastructure/config/manager";
import { resourceRegistryPort } from "@afk/execution/infrastructure/runtime/resource-registry-port";
import { runSessionPort } from "@afk/execution/infrastructure/runtime/run-session-port";
import type { BacklogPlatform } from "../shared/backlog-contract.js";

const requireCjs = createRequire(import.meta.url);

/**
 * The desktop's composition root.
 *
 * The Electron main process assembles the shared application use cases and
 * the infrastructure that backs them, the same way the CLI does. Providers
 * are cached per workspace and platform: building one resolves the tracker
 * from the workspace's git remote and creates the provider client, which is
 * worth keeping warm across calls.
 *
 * The provider factory is reached through the CommonJS runtime bundle rather
 * than a direct import, so the end-to-end suite can replace the bundle with
 * a fixture and drive the desktop without a real provider.
 */
type RuntimeBundle = {
  createManagementProviders: (
    projectId: string | undefined,
    cwd: string,
    platform?: WorkItemPlatform,
  ) => Promise<ManagementProviderBundle>;
  executeWorkItem: (input: {
    workItemId: string;
    manifestPath: string;
    template?: string;
    executionId?: string;
    project?: string;
  }) => Promise<{
    executionId: string;
    workItemId: string;
    status: ExecuteWorkItemStatus;
    changeUrl?: string;
  }>;
};

let runtimeBundle: RuntimeBundle | undefined;

function loadRuntimeBundle(): RuntimeBundle {
  if (runtimeBundle) return runtimeBundle;
  // The path comes from the app root, not from this module's location: main.js
  // is a bundle, so every inlined module shares one URL and module-relative
  // depth no longer means anything.
  const bundle = path.join(app.getAppPath(), "dist-electron", "provider-inventory.cjs");
  runtimeBundle = requireCjs(bundle) as RuntimeBundle;
  return runtimeBundle;
}

/**
 * The runtime ports the desktop is wired to.
 *
 * The runner's configuration and the runner's resource registry are reached
 * through the ports the application package declares, so the desktop does
 * not inherit the file layout, the constructor arguments or the failure
 * modes of the adapters that implement them. The choice of an adapter is
 * made here, once; the rest of the desktop states what it needs.
 */
export const desktopRuntimePorts = {
  configuration: fileConfigurationPort,
  resources: resourceRegistryPort,
  runSession: runSessionPort,
};

const bundles = new Map<string, Promise<ManagementProviderBundle>>();

export function providerBundle(
  workspace: string,
  platform?: BacklogPlatform,
): Promise<ManagementProviderBundle> {
  const key = `${workspace} ${platform ?? "auto"}`;
  const cached = bundles.get(key);
  if (cached) return cached;
  const pending = loadRuntimeBundle().createManagementProviders(undefined, workspace, platform).catch(error => {
    // A failed assembly is not cached: the next call retries it.
    bundles.delete(key);
    throw error;
  });
  bundles.set(key, pending);
  return pending;
}

/**
 * The work item execution runtime, reached through the same bundle so the
 * end-to-end suite can drive the desktop without running a real agent.
 */
export function executeWorkItem(): RuntimeBundle["executeWorkItem"] {
  return loadRuntimeBundle().executeWorkItem;
}

export async function backlogProviders(
  workspace: string,
  platform?: BacklogPlatform,
): Promise<BacklogManagementProvider> {
  return (await providerBundle(workspace, platform)).backlog;
}

/**
 * The branch a confirmed merge must target.
 *
 * The CLI reads it from the same workspace config file the desktop reads
 * here, so both agree on the target branch for a given workspace.
 */
export async function workflowTargetBranch(workspace: string): Promise<string> {
  return desktopRuntimePorts.configuration.workflow(workspace).targetBranch;
}

