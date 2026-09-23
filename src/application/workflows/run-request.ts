import type { AgentProviderName, AgentRuntimeSelection, ExecutionMode } from '../../domain/agents/types';
import type { SandboxProviderName } from '../../infrastructure/sandbox/types';
import type { BranchStrategyConfig } from '../../domain/branches/types';
import { deriveBacklogBranchName } from '../../domain/backlog/index';
import { getWorkflowConfig, type WorkflowConfig } from '../../infrastructure/config/manager';
import { resolveProjectContext, type ProjectContext } from '../project-context';
import { resolveAgentProviderName } from '../../domain/agents/index';
import { DEFAULT_CODEX_CONFIG, resolveCodexRuntime } from '../../domain/agents/codex-runtime';
import {
  readExecutionManifest,
  type ReadExecutionManifestDependencies,
  type ExecutionManifestPlatform,
  type ResolvedExecutionManifest,
  type ResolvedExecutionManifestRepository,
} from './execution-manifest';
import { resolveGitLabProjectKey } from '../../shared/gitlab-project';

export type WorkflowRunRepository = ResolvedExecutionManifestRepository;

/** Canonical request for a single backlog implementation execution. */
export interface WorkflowRunRequest {
  backlogId: string;
  workItemId?: string;
  repoRoot: string;
  workspaceRoot: string;
  projectName?: string;
  trackerPlatform?: ExecutionManifestPlatform;
  trackerProjectId?: string;
  trackerHost?: string;
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
  repositories?: WorkflowRunRepository[];
  ext?: string[];
  extParams?: string[];
  template?: string;
}

export interface WorkflowRunCliInput {
  backlogId: string;
  workItemId?: string;
  session?: string;
  projectName?: string;
  repoRoot?: string;
  workspaceRoot?: string;
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
  executionManifestPath?: string;
  repositories?: WorkflowRunRepository[];
  trackerPlatform?: ExecutionManifestPlatform;
  trackerProjectId?: string;
  trackerHost?: string;
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
    workItemId: input.workItemId,
    repoRoot: context.repoRoot,
    workspaceRoot: input.workspaceRoot ?? context.repoRoot,
    projectName: input.projectName ?? context.projectName,
    trackerPlatform: input.trackerPlatform,
    trackerProjectId: input.trackerProjectId,
    trackerHost: input.trackerHost,
    originalCwd: context.originalCwd,
    session: input.session ?? `afk-${input.workItemId ?? backlogId}`,
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
    repositories: input.repositories,
    ext: input.ext,
    extParams: input.extParams,
    template: input.template ?? config.template,
  };
}

function resolveDefaultCodexRuntime(config: Partial<WorkflowConfig>): AgentRuntimeSelection {
  const configured = config.agents?.codex ?? {
    ...DEFAULT_CODEX_CONFIG,
    appServer: { ...DEFAULT_CODEX_CONFIG.appServer },
  };
  return resolveCodexRuntime({ cli: {}, config: configured });
}

export async function resolveWorkflowRunRequest(
  input: WorkflowRunCliInput,
  config?: Partial<WorkflowConfig>,
  dependencies: ReadExecutionManifestDependencies = {},
): Promise<WorkflowRunRequest> {
  const normalizedInput = input.executionManifestPath
    ? applyExecutionManifest(input, await readExecutionManifest(input.executionManifestPath, input.backlogId, dependencies))
    : input;
  const project = await resolveProjectContext({
    repoRoot: normalizedInput.repoRoot,
    projectName: normalizedInput.projectName,
    cwd: dependencies.cwd,
  });
  return resolveWorkflowRequest(normalizedInput, config, project);
}

function applyExecutionManifest(
  input: WorkflowRunCliInput,
  manifest: ResolvedExecutionManifest,
): WorkflowRunCliInput {
  const primary = manifest.repositories.find(repository => repository.primary);
  if (!primary) throw new Error(`Invalid execution manifest at ${manifest.manifestPath}: primary repository is missing`);
  const branchStrategy: BranchStrategyConfig = {
    type: 'named',
    branch: manifest.workingBranch,
    baseBranch: primary.baseBranch,
  };
  rejectConflict('--project', input.projectName, primary.projectKey, manifest.manifestPath);
  rejectConflict('--base-branch', input.baseBranch, primary.baseBranch, manifest.manifestPath);
  rejectConflict('--target-branch', input.targetBranch, manifest.workingBranch, manifest.manifestPath);
  if (input.branchStrategy && !sameBranchStrategy(input.branchStrategy, branchStrategy)) {
    throw new Error(`branch strategy conflicts with execution manifest at ${manifest.manifestPath}`);
  }
  const tracker = trackerContext(manifest.tracker);
  return {
    ...input,
    backlogId: manifest.providerBacklogId,
    workItemId: manifest.workItemId,
    projectName: primary.projectKey,
    trackerPlatform: manifest.tracker.platform,
    trackerProjectId: tracker.projectId,
    trackerHost: tracker.host,
    repoRoot: primary.repoRoot,
    workspaceRoot: manifest.workspaceRoot,
    baseBranch: primary.baseBranch,
    targetBranch: manifest.workingBranch,
    branchStrategy,
    repositories: manifest.repositories,
  };
}

function trackerContext(repository: ResolvedExecutionManifest['tracker']): { projectId: string; host?: string } {
  if (repository.platform === 'github') return { projectId: repository.projectKey };
  const { host, projectPath } = resolveGitLabProjectKey(repository.projectKey, repository.providerHost);
  return {
    projectId: repository.providerProjectId ?? projectPath,
    ...(repository.providerHost ? { host } : {}),
  };
}

function sameBranchStrategy(left: BranchStrategyConfig, right: BranchStrategyConfig): boolean {
  return left.type === 'named'
    && right.type === 'named'
    && left.branch === right.branch
    && left.baseBranch === right.baseBranch;
}

function rejectConflict(flag: string, explicitValue: string | undefined, manifestValue: string, manifestPath: string): void {
  if (explicitValue !== undefined && explicitValue !== manifestValue) {
    throw new Error(`${flag} conflicts with execution manifest at ${manifestPath}: expected '${manifestValue}', got '${explicitValue}'`);
  }
}
