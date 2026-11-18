/**
 * Shared workflow entry point used by `afk run`.
 * Learning templates run before managed execution resources are resolved.
 */
import { randomUUID } from 'node:crypto';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import type { SandboxProviderName } from '../../infrastructure/sandbox/types.js';
import type { AgentProviderName, AgentRuntimeSelection, ExecutionMode } from '../../domain/agents/types.js';
import type { AgentProviderRegistry } from '../../domain/agents/registry.js';
import { executeWorkItem } from './execute-work-item.js';
import type { BranchStrategyConfig } from '../../domain/branches/types.js';
import { resolveWorkflowRunRequest } from './run-request.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import { TemplateLoader } from '../../domain/templates/loader.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import { resolveAgentProviderName } from '../../domain/agents/index.js';
import { resolveCodexRuntime, type CodexRuntimeOverrides } from '../../domain/agents/codex-runtime.js';
import { WorkflowRunner } from '../workflow-engine.js';
import { createPluginRunObserver } from '../plugins/observability.js';
import type { StepResult, WorkflowTemplate } from '../../domain/templates/types.js';
import { learningIdentitySchema } from '../learning/requests.js';
import { learningScopeSchema } from '../learning/contracts.js';

export interface RunWorkflowCliOpts {
  plugins?: PluginRuntime;
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
  agentRuntimeOverrides?: CodexRuntimeOverrides;
  agentProviderRegistry?: AgentProviderRegistry;
  executionMode?: ExecutionMode;
  branchStrategy?: BranchStrategyConfig;
  template?: string;
  executionManifestPath?: string;
}

export interface RunWorkflowCliResult {
  success: boolean;
  url?: string;
  steps?: Record<string, StepResult>;
}

function runLearningTemplate(opts: RunWorkflowCliOpts, cfg: ReturnType<typeof getWorkflowConfig>, template: WorkflowTemplate): Promise<RunWorkflowCliResult> {
  if (opts.executionManifestPath !== undefined) throw new Error('learning templates cannot use an execution manifest');
  if ([opts.targetBranch, opts.baseBranch, opts.branchStrategy, opts.sandboxProvider, opts.agentProvider,
    opts.agentRuntime, opts.agentRuntimeOverrides, opts.executionMode].some(value => value !== undefined)) {
    throw new Error('learning templates cannot use execution branch, sandbox or agent options');
  }
  const identity = parseWorkItemId(opts.backlogId.trim());
  const runner = new WorkflowRunner(undefined, { config: cfg, plugins: opts.plugins, template,
    observer: createPluginRunObserver(opts.plugins) });
  return runner.run({ purpose: 'learning', backlogId: identity.id, workItemId: identity.id,
    session: opts.session ?? `learning-${randomUUID()}`, targetBranch: cfg.targetBranch ?? 'main',
    repoRoot: process.cwd(), workspaceRoot: process.cwd(), projectName: opts.projectName,
    hardTimeoutMs: opts.hardTimeoutMs, ext: opts.ext, extParams: opts.extParams });
}

type ReviewWorkflowOptions = Pick<RunWorkflowCliOpts, 'plugins' | 'backlogId' | 'session' | 'hardTimeoutMs'> & {
  sourceRunId: string; checkerId: string;
};

async function runReviewWorkflow(opts: ReviewWorkflowOptions, kind: 'process' | 'lesson' | 'skill' | 'tool'): Promise<RunWorkflowCliResult> {
  const identity = parseWorkItemId(opts.backlogId);
  const input = { scope: learningScopeSchema.parse(`${identity.platform}:${identity.projectKey}`), workItemId: identity.id, runId: learningIdentitySchema.parse(opts.sourceRunId),
    kind, checkerId: learningIdentitySchema.parse(opts.checkerId), ...(kind === 'lesson' ? { repair: true } : {}) };
  return runLearningTemplate(opts, getWorkflowConfig(), { name: kind === 'skill' || kind === 'tool' ? `${kind}-optimization-validation`
    : kind === 'lesson' ? 'repair-review-preview' : 'success-review-preview', version: 1, purpose: 'learning',
    description: kind === 'skill' || kind === 'tool' ? `Review an execution and validate ${kind} optimization candidates.`
      : kind === 'lesson' ? 'Review a failure, implementation repair and independent QA to prepare a verified lesson.'
      : 'Review a successful execution and prepare verified business-process knowledge.',
    steps: [{ id: 'review', kind: 'system', action: 'learning.retrospective', input }] });
}

export function runSuccessReviewWorkflow(opts: ReviewWorkflowOptions): Promise<RunWorkflowCliResult> {
  return runReviewWorkflow(opts, 'process');
}

export function runRepairReviewWorkflow(opts: ReviewWorkflowOptions): Promise<RunWorkflowCliResult> {
  return runReviewWorkflow(opts, 'lesson');
}

export function runOptimizationReviewWorkflow(opts: ReviewWorkflowOptions & { kind: 'skill' | 'tool' }): Promise<RunWorkflowCliResult> {
  return runReviewWorkflow(opts, opts.kind);
}

export async function runWorkflowCli(opts: RunWorkflowCliOpts): Promise<RunWorkflowCliResult> {
  const cfg = getWorkflowConfig();
  const templateName = opts.template ?? cfg.template ?? 'issue-implementation';
  const template = await new TemplateLoader({ getPluginTemplate: name => opts.plugins?.getTemplate(name) }).load(templateName);
  if (template.purpose === 'learning') return runLearningTemplate(opts, cfg, template);
  const agentProviderRegistry = opts.agentProviderRegistry ?? opts.plugins?.getAgentProviderRegistry();
  const { agentRuntimeOverrides, ...options } = opts;
  if (agentRuntimeOverrides) {
    const provider = resolveAgentProviderName(opts.agentProvider ?? cfg.agentDefault, agentProviderRegistry);
    options.agentRuntime = provider === 'codex' ? resolveCodexRuntime({ cli: agentRuntimeOverrides, config: cfg.agents.codex }) : { kind: 'default' };
  }
  const request = await resolveWorkflowRunRequest(
    options,
    cfg,
    agentProviderRegistry ? { agentProviderRegistry } : undefined,
  );
  if (!request.workItemId) throw new Error('run requires a canonical work item identity');
  const { plugins, agentProviderRegistry: _registry, ...runOptions } = options;
  const executionInput = {
    workItemId: request.workItemId, executionId: opts.session,
    manifestPath: opts.executionManifestPath, template: opts.template, project: opts.projectName,
    runOptions,
  };
  const result = await executeWorkItem(executionInput, { plugins, agentProviderRegistry, template });
  return { success: result.status === 'merge_ready' || result.status === 'done', url: result.changeUrl };
}
