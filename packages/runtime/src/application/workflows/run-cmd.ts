/**
 * Shared single-backlog execution entry point used exclusively by `afk run`.
 * It claims before creating workflow resources; loop claims its own items.
 */
import { WorkflowRunner } from '../workflow-engine.js';
import { createRunObserver } from '../../infrastructure/observability/run-observer-factory.js';
import { createTracker } from '../../infrastructure/provider/tracker-provider-factory.js';
import { createProviderBundle } from '../../infrastructure/provider/providers.js';
import { createCrossProjectBacklogGraphSource } from '../../infrastructure/provider/backlog-graph.js';
import { logger } from '../../infrastructure/io/index.js';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import type { SandboxProviderName } from '../../infrastructure/sandbox/types.js';
import type { AgentProviderName, AgentRuntimeSelection, ExecutionMode } from '../../domain/agents/types.js';
import { prepareAgentRuntime } from '../../domain/agents/codex-runtime.js';
import type { BranchStrategyConfig } from '../../domain/branches/types.js';
import { resolveWorkflowRunRequest } from './run-request.js';

export interface RunWorkflowCliOpts {
  backlogId: string;
  session?: string;
  projectName?: string;
  targetBranch?: string;
  baseBranch?: string;
  maxRetries?: number;
  hardTimeoutMs?: number;
  maxHandoffs?: number;
  contextHighTokens?: number;
  maxTotalTokens?: number;
  ext?: string[];
  extParams?: string[];
  sandboxProvider?: SandboxProviderName;
  agentProvider?: AgentProviderName;
  agentRuntime?: AgentRuntimeSelection;
  executionMode?: ExecutionMode;
  branchStrategy?: BranchStrategyConfig;
  template?: string;
  executionManifestPath?: string;
}

export interface RunWorkflowCliResult {
  success: boolean;
  url?: string;
}

export async function runWorkflowCli(opts: RunWorkflowCliOpts): Promise<RunWorkflowCliResult> {
  const cfg = getWorkflowConfig();
  const request = await resolveWorkflowRunRequest(opts, cfg);
  request.agentRuntime = await prepareAgentRuntime(request.agentRuntime);
  const tracker = await createTracker(
    request.trackerProjectId ?? request.projectName,
    request.repoRoot,
    request.trackerPlatform,
    request.trackerHost,
  );
  const providers = createProviderBundle(tracker, request.repoRoot, {
    // A child backlog may live in another repository than its parent, so the
    // provider needs the whole backlog graph before it claims an item.
    graph: createCrossProjectBacklogGraphSource({ platform: request.trackerPlatform }),
    onGraphError: error => logger.warn({ error }, 'cross-project backlog graph is unavailable; falling back to the local project'),
    ...(request.trackerProjectKey ? { projectKey: request.trackerProjectKey } : {}),
  });
  const runner = new WorkflowRunner(providers, { config: cfg, agentRuntime: request.agentRuntime, observer: createRunObserver() });
  const result = await runner.run(request);
  return { success: result.success, url: result.url };
}
