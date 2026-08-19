/**
 * Shared single-backlog execution entry point used exclusively by `afk run`.
 * It claims before creating workflow resources; loop claims its own items.
 */
import { WorkflowRunner, type RunnerOptions } from '../workflow-engine';
import { createTracker } from '../tracker-provider-factory';
import { createProviderBundle } from '../providers';
import { getWorkflowConfig } from '../../infrastructure/config/manager';
import type { SandboxProviderName } from '../../infrastructure/sandbox/types';
import type { AgentProviderName, AgentRuntimeSelection, ExecutionMode } from '../../domain/agents/types';
import { prepareAgentRuntime } from '../../domain/agents/codex-runtime';
import type { BranchStrategyConfig } from '../../domain/branches/types';
import { resolveWorkflowRunRequest } from './run-request';

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
}

export interface RunWorkflowCliResult {
  success: boolean;
  url?: string;
}

export async function runWorkflowCli(opts: RunWorkflowCliOpts): Promise<RunWorkflowCliResult> {
  const cfg = getWorkflowConfig();
  const request = await resolveWorkflowRunRequest(opts, cfg);
  request.agentRuntime = await prepareAgentRuntime(request.agentRuntime);
  const tracker = await createTracker(request.projectName, request.repoRoot);
  const providers = createProviderBundle(tracker, request.repoRoot);
  const runner = new WorkflowRunner(providers, { config: cfg, agentRuntime: request.agentRuntime });
  const result = await runner.run(request as unknown as RunnerOptions);
  return { success: result.success, url: result.url };
}
