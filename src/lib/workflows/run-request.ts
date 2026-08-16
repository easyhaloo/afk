import type { AgentProviderName, AgentRuntimeSelection, ExecutionMode } from '../agents/types';
import type { SandboxProviderName } from '../sandbox/types';
import type { BranchStrategyConfig } from '../branches/types';
import { deriveBacklogBranchName } from '../core/backlog';
import { getWorkflowConfig, type WorkflowConfig } from '../core/config/manager';
import { resolveProjectContext, type ProjectContext } from '../core/project-context';
import { resolveAgentProviderName } from '../agents';
import { DEFAULT_CODEX_CONFIG, resolveCodexRuntime } from '../agents/codex-runtime';

/** Canonical request for a single backlog implementation execution. */
export interface WorkflowRunRequest {
  backlogId: string;
  repoRoot: string;
  projectName?: string;
  originalCwd: string;
  session: string;
  targetBranch: string;
  baseBranch: string;
  maxRetries: number;
  hardTimeoutMs: number;
  completionTimeoutMs: number;
  maxHandoffs: number;
  contextHighTokens: number;
  maxTotalTokens: number;
  provider: AgentProviderName;
  agentProvider: AgentProviderName;
  sandboxProvider: SandboxProviderName;
  executionMode: ExecutionMode;
  agentRuntime: AgentRuntimeSelection;
  branchStrategy: BranchStrategyConfig;
  ext?: string[];
  extParams?: string[];
  template?: string;
}

export interface WorkflowRunCliInput {
  backlogId: string;
  session?: string;
  projectName?: string;
  repoRoot?: string;
  targetBranch?: string;
  baseBranch?: string;
  maxRetries?: number;
  hardTimeoutMs?: number;
  completionTimeoutMs?: number;
  maxHandoffs?: number;
  contextHighTokens?: number;
  maxTotalTokens?: number;
  sandboxProvider?: SandboxProviderName;
  agentProvider?: AgentProviderName;
  provider?: AgentProviderName;
  executionMode?: ExecutionMode | string;
  agentRuntime?: AgentRuntimeSelection;
  branchStrategy?: BranchStrategyConfig;
  ext?: string[];
  extParams?: string[];
  template?: string;
}

const defaults = {
  targetBranch: 'main',
  baseBranch: 'main',
  maxRetries: 2,
  hardTimeoutMs: 7_200_000,
  completionTimeoutMs: 7_200_000,
  contextHighTokens: 100_000,
  goalBudget: 10_000_000,
  sandboxProvider: 'local' as SandboxProviderName,
  agentProvider: 'claude-code' as AgentProviderName,
  executionMode: 'interactive' as ExecutionMode,
};

function executionMode(raw: ExecutionMode | string | undefined): ExecutionMode {
  if (raw === undefined) return defaults.executionMode;
  if (raw === 'interactive' || raw === 'batch') return raw;
  throw new Error(`invalid execution-mode: ${raw}; expected interactive or batch`);
}

function deriveBranchStrategy(backlogId: string, raw?: BranchStrategyConfig): BranchStrategyConfig {
  if (raw) return raw;
  return { type: 'named', branch: deriveBacklogBranchName(backlogId) };
}

/** Normalize CLI/config values into the one request consumed by the runner. */
export function resolveWorkflowRequest(
  input: WorkflowRunCliInput,
  config: Partial<WorkflowConfig> = getWorkflowConfig(),
  project?: ProjectContext,
): WorkflowRunRequest {
  const backlogId = input.backlogId?.trim();
  if (!backlogId) throw new Error('backlogId is required');
  const budget = input.maxTotalTokens ?? config.goalBudget ?? defaults.goalBudget;
  const agentProvider = resolveAgentProviderName(
    input.agentProvider ?? input.provider ?? config.agentDefault ?? defaults.agentProvider,
  );
  const context = project ?? {
    repoRoot: input.repoRoot ?? process.cwd(),
    projectName: input.projectName,
    originalCwd: process.cwd(),
  };
  return {
    backlogId,
    repoRoot: context.repoRoot,
    projectName: input.projectName ?? context.projectName,
    originalCwd: context.originalCwd,
    session: input.session ?? `afk-${backlogId}`,
    targetBranch: input.targetBranch ?? config.targetBranch ?? defaults.targetBranch,
    baseBranch: input.baseBranch ?? config.trackerTargetBranch ?? config.targetBranch ?? defaults.baseBranch,
    maxRetries: input.maxRetries ?? config.maxRetries ?? defaults.maxRetries,
    hardTimeoutMs: input.hardTimeoutMs ?? config.workflowHardTimeout ?? defaults.hardTimeoutMs,
    completionTimeoutMs: input.completionTimeoutMs ?? config.completionTimeout ?? defaults.completionTimeoutMs,
    maxHandoffs: input.maxHandoffs ?? Math.min(Math.ceil(budget / 1_000_000), 20),
    contextHighTokens: input.contextHighTokens ?? config.contextThreshold ?? defaults.contextHighTokens,
    maxTotalTokens: budget,
    provider: agentProvider,
    agentProvider,
    sandboxProvider: input.sandboxProvider ?? defaults.sandboxProvider,
    executionMode: executionMode(input.executionMode),
    agentRuntime: agentProvider === 'codex'
      ? (input.agentRuntime?.kind === 'codex' ? input.agentRuntime : resolveDefaultCodexRuntime(config))
      : { kind: 'default' },
    branchStrategy: deriveBranchStrategy(backlogId, input.branchStrategy),
    ext: input.ext,
    extParams: input.extParams,
    template: input.template,
  };
}

function resolveDefaultCodexRuntime(config: Partial<WorkflowConfig>): AgentRuntimeSelection {
  const configured = config.agents?.codex ?? {
    ...DEFAULT_CODEX_CONFIG,
    appServer: { ...DEFAULT_CODEX_CONFIG.appServer },
  };
  return resolveCodexRuntime({ cli: {}, config: configured });
}

export async function resolveWorkflowRunRequest(input: WorkflowRunCliInput, config?: Partial<WorkflowConfig>): Promise<WorkflowRunRequest> {
  const project = await resolveProjectContext({ repoRoot: input.repoRoot, projectName: input.projectName });
  return resolveWorkflowRequest(input, config, project);
}
