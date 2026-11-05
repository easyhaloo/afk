/**
 * Shared single-backlog execution entry point used exclusively by `afk run`.
 * It claims before creating workflow resources; loop claims its own items.
 */
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import type { SandboxProviderName } from '../../infrastructure/sandbox/types.js';
import type { AgentProviderName, AgentRuntimeSelection, ExecutionMode } from '../../domain/agents/types.js';
import { executeWorkItem } from './execute-work-item.js';
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
  if (!request.workItemId) throw new Error('run requires a canonical work item identity');
  const result = await executeWorkItem({
    workItemId: request.workItemId, executionId: opts.session,
    manifestPath: opts.executionManifestPath, template: opts.template, project: opts.projectName,
    runOptions: opts,
  });
  return { success: result.status === 'merge_ready' || result.status === 'done', url: result.changeUrl };
}
