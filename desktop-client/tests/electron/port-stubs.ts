import type { ConfigurationPort, WorkflowConfig } from "@afk/application";
import type { ResourceAdapter } from "../../electron/adapters/resource-adapter.js";

/**
 * The ports the desktop's services are wired to, as a test states them.
 *
 * The desktop reaches the runner's configuration and the runner's resource
 * registry through the ports the application package declares, so a test
 * says what the runtime would say instead of writing a file the runtime
 * would have to read.
 */

export function stubWorkflowConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    agentDefault: "codex",
    tmuxSession: "afk",
    completionTimeout: 7_200_000,
    qaTimeout: 1_800_000,
    workflowHardTimeout: 7_200_000,
    completionPoll: 5,
    idleTimeout: 1_800_000,
    acCheckTimeout: 180_000,
    contextThreshold: 100_000,
    promptTimeout: 30_000,
    handoffTimeout: 60_000,
    maxRetries: 2,
    maxSelfIterations: 2,
    maxQaReworkAttempts: 3,
    targetBranch: "main",
    trackerTargetBranch: "main",
    goalBudget: 10_000_000,
    agents: {
      codex: {
        transport: "auto",
        auth: "auto",
        provider: "openai",
        appServer: { startupTimeoutMs: 30_000 },
      },
    },
    ...overrides,
  };
}

export function stubConfigurationPort(overrides: Partial<ConfigurationPort> = {}): ConfigurationPort {
  return {
    workflow: () => stubWorkflowConfig(),
    defaults: () => stubWorkflowConfig({ targetBranch: "defaults", trackerTargetBranch: "defaults" }),
    scheduler: () => ({ maxConcurrent: 3, pollInterval: 60, requiredLabels: [], excludeLabels: [], waveNotify: true, updateDashboard: true }),
    gitLab: () => ({ url: "https://gitlab.com", token: "" }),
    ...overrides,
  };
}

export function stubResourceAdapter(overrides: Partial<ResourceAdapter> = {}): ResourceAdapter {
  return {
    listAfkContainers: async () => [],
    listAfkTmux: async () => [],
    isAfkTmuxSession: () => false,
    listRunResources: () => [],
    ...overrides,
  };
}
