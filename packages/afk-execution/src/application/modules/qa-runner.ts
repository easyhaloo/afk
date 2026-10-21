import { promises as fs } from 'fs';
import { captureWorktreeDiagnostics } from '../../infrastructure/git/worktree-diagnostics.js';
import { createTmuxClient, type TmuxClient } from '../../infrastructure/tmux/index.js';
import { configureStatusline, logger, getLogContext, withLogContext } from '@afk/infrastructure';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import { TemplateCatalog } from '../../domain/templates/catalog.js';
import { createAgentProvider, resolveAgentProviderName } from '../../domain/agents/index.js';
import { createSandboxProvider } from '../../infrastructure/sandbox/index.js';
import type { AgentProvider, AgentRuntimeSelection, AgentExecutionMode } from '../../domain/agents/types.js';
import { sandboxKindOf, type AgentExecution, type Sandbox, type SandboxProvider, type ExecutionResult } from '../../domain/sandbox/types.js';
import type { ManagementProviderBundle } from '@afk/infrastructure';
import type { WorkflowConfig } from '../../domain/config/types.js';
import type { BacklogItem, NewReworkRecord } from '@afk/application';
import type { ChangeRequest } from '@afk/infrastructure';
import { formatExecutionFailure } from '../workflow-engine.js';
import { buildExecutionPrompt } from '../workflows/execution-protocol.js';
import { TaskRuntimeManager } from '../runtime/task-runtime.js';
import { runtimeFieldsFromExecution } from '../runtime/agent-metadata.js';
import { BudgetManager } from '../workflows/budget.js';
import { MultiRepositoryPreparer, type MultiRepositoryPreparationService, type PreparedRepositorySet } from '../workflows/multi-repository-preparer.js';
import type { WorkflowRunRepository } from '../workflows/run-request.js';
import { BudgetStore } from '../workflows/budget-store.js';
import { RuntimeLifecycle, type RuntimeLifecycleLabels } from '../runtime/runtime-lifecycle.js';
import { collectAgentTelemetry } from '../../infrastructure/observability/agent-telemetry.js';
import type { RunEventData } from '@afk/core';

/**
 * The labels a QA run logs its runtime lifecycle under. They are the runner's
 * own words: a workflow run and a QA run are not the same run, and the
 * monitor should be able to tell them apart in the log.
 */
const QA_RUNTIME_LABELS: RuntimeLifecycleLabels = {
  publish: 'failed to publish QA runtime',
  heartbeat: 'failed to update QA runtime',
  archive: 'failed to archive QA runtime',
  diagnostics: 'failed to persist QA runtime diagnostics',
};

/** The summary a blocked QA run records when it has none of its own. */
const QA_RUNTIME_ERROR_SUMMARY = 'QA execution failed';

type QAResultObject = { [key: string]: unknown };
type QAFailureCriterion = { id: string; expected: string; actual: string };
type QAProcessResult = { success: boolean; mrUrl?: string; autoMerged?: boolean; rework?: boolean; summary?: string; failureCode?: 'qa_timeout' | 'qa_execution_failed' | 'qa_rework' | 'provider_change_unconfirmed'; failedCriteria?: QAFailureCriterion[] };

export interface QARunnerDependencies {
  sandboxProvider?: SandboxProvider;
  agentProvider?: AgentProvider;
  agentRuntime?: AgentRuntimeSelection;
  tmux?: TmuxClient;
  executionMode?: AgentExecutionMode;
  projectRoot?: string;
  /** Managed workspace to run QA against; QA prepares it if it is gone. */
  repositories?: readonly WorkflowRunRepository[];
  prepareRepositories?: MultiRepositoryPreparationService;
  mergeBranch?: (worktreePath: string, baselineBranch: string, featureBranch: string) => Promise<void>;
  runtimeManager?: TaskRuntimeManager;
  beforeChange?: (action: 'publish' | 'merge', backlog: BacklogItem, change?: ChangeRequest) => Promise<void>;
  afterPublication?: (change: ChangeRequest) => Promise<void>;
  onCommit?: (commitSha: string, branch: string) => Promise<void>;
  onSession?: (data: Extract<RunEventData, { kind: 'agent.session_recorded' }>) => Promise<void>;
  /**
   * The template catalogue the QA step is read from. The catalogue owns the
   * templates and the plan they compile into.
   */
  catalog?: TemplateCatalog;
}

/**
 * QA worker for items in verification.
 *
 * QA owns the verification workflow, but not the execution transport. The
 * provider creates either a batch AgentExecution or an interactive tmux-backed
 * AgentExecution. This runner waits for the typed result and routes backlog state.
 */
export class QARunner {
  private readonly logDir: string;
  private readonly config: WorkflowConfig;
  private readonly providers: ManagementProviderBundle;
  private readonly sandboxProvider: SandboxProvider;
  private readonly agentProvider: AgentProvider;
  private readonly agentRuntime?: AgentRuntimeSelection;
  private readonly tmux?: TmuxClient;
  private readonly executionMode: AgentExecutionMode;
  private readonly projectRoot: string;
  private readonly repositories?: readonly WorkflowRunRepository[];
  private readonly prepareRepositories: MultiRepositoryPreparationService;
  private readonly mergeBranchOverride?: (worktreePath: string, baselineBranch: string, featureBranch: string) => Promise<void>;
  private readonly runtimeManager: TaskRuntimeManager;
  private readonly beforeChange?: QARunnerDependencies['beforeChange'];
  private readonly afterPublication?: QARunnerDependencies['afterPublication'];
  private readonly onCommit?: QARunnerDependencies['onCommit'];
  private readonly onSession?: QARunnerDependencies['onSession'];
  private readonly catalog: TemplateCatalog;

  constructor(providers: ManagementProviderBundle, config?: WorkflowConfig, deps: QARunnerDependencies = {}) {
    this.logDir = `${process.env.HOME}/.claude/logs/afk/qa`;
    this.config = config ?? getWorkflowConfig();
    this.providers = providers;
    // The verification phase is headless by default: it checks acceptance
    // criteria and reports, and nobody attaches to a verification agent. A
    // caller that wants a session to watch asks for the interactive mode.
    this.executionMode = deps.executionMode ?? 'batch';
    this.projectRoot = deps.projectRoot ?? process.cwd();
    this.catalog = deps.catalog ?? new TemplateCatalog({ projectRoot: this.projectRoot });
    this.repositories = deps.repositories;
    this.prepareRepositories = deps.prepareRepositories ?? new MultiRepositoryPreparer();
    this.mergeBranchOverride = deps.mergeBranch;
    this.runtimeManager = deps.runtimeManager ?? new TaskRuntimeManager();
    this.beforeChange = deps.beforeChange;
    this.afterPublication = deps.afterPublication;
    this.onCommit = deps.onCommit;
    this.onSession = deps.onSession;
    this.sandboxProvider = deps.sandboxProvider ?? createSandboxProvider('local');
    this.agentProvider = deps.agentProvider ?? createAgentProvider(resolveAgentProviderName(this.config.agentDefault));
    this.agentRuntime = deps.agentRuntime;
    this.tmux = deps.tmux ?? (this.executionMode === 'interactive' ? createTmuxClient() : undefined);
  }

  async process(backlogId: string): Promise<QAProcessResult> {
    const id = String(backlogId);
    const session = `qa-${id}-${Date.now()}`;
    return withLogContext(getLogContext() ?? { runId: `${session}-runtime`, workItemId: id }, () => this.processObserved(id, session));
  }

  private async processObserved(id: string, session: string): Promise<QAProcessResult> {
    logger.info({ backlogId: id, executionMode: this.executionMode }, 'QA processing started');
    let worktreePath: string | undefined;
    let sandbox: Sandbox | undefined;
    let execution: AgentExecution | undefined;
    let workspace: PreparedRepositorySet | undefined;
    const runtimeRunId = `${session}-runtime`;
    // One lifecycle per QA run: the record, its heartbeats and its archive
    // belong to the run that is happening now.
    const runtime = new RuntimeLifecycle({ store: this.runtimeManager, labels: QA_RUNTIME_LABELS });
    let runtimeErrorSummary: string | undefined;

    try {
      const backlog = await this.providers.backlog.get(id);
      const budgetStore = new BudgetStore(this.projectRoot, backlog.workItemId ?? backlog.providerRef);
      const savedBudget = await budgetStore.load();
      const maxHandoffs = Math.min(Math.ceil(this.config.goalBudget / 1_000_000), 20);
      const budget = savedBudget
        ? BudgetManager.fromSnapshot(savedBudget, maxHandoffs, this.config.goalBudget)
        : new BudgetManager(maxHandoffs, this.config.goalBudget);
      if (budget.isExhausted()) {
        const summary = `work item budget exhausted: ${budget.exhaustionReason()}`;
        await this.markBlocked(id, summary);
        return { success: false, summary };
      }
      const baselineBranch = await this.resolveExecutionBranch(backlog);
      await runtime.start({
        runId: runtimeRunId,
        phase: 'verifying',
        record: {
          backlogId: backlog.id,
          workspace: this.projectRoot,
          providerRef: backlog.providerRef,
          title: backlog.title,
          sandboxProvider: this.sandboxProvider.name,
          executionMode: this.executionMode,
          agentProvider: this.agentProvider.name,
          runtime: this.agentRuntime,
          ...(this.executionMode === 'interactive' ? { session } : {}),
          branch: backlog.branchName,
          progress: 'QA starting',
        },
      });
      workspace = await this.prepareWorkspace(id);
      const handle = await this.providers.branches.createVerificationWorktree(backlog, baselineBranch);
      worktreePath = handle.worktreePath;
      await this.logWorktreeDiagnostics(id, 'worktree-created', worktreePath);
      await runtime.heartbeat({ worktree: worktreePath, branch: handle.branchName, progress: 'QA worktree created' });
      logger.info({ backlogId: id, worktree: worktreePath, baselineBranch }, 'QA worktree created');

      const featureBranch = backlog.branchName;
      if (!featureBranch) {
        const summary = 'QA execution failed: feature branch could not be resolved';
        await this.markBlocked(id, summary);
        return { success: false, summary, failureCode: 'qa_execution_failed' };
      }
      if (this.mergeBranchOverride) await this.mergeBranchOverride(worktreePath, baselineBranch, featureBranch);
      else await this.mergeBranch(worktreePath, baselineBranch, featureBranch);
      await this.logWorktreeDiagnostics(id, 'branches-merged', worktreePath);
      if (this.executionMode === 'interactive') {
        await configureStatusline(worktreePath);
        await this.logWorktreeDiagnostics(id, 'statusline-configured', worktreePath);
      }

      // The catalogue owns the templates and the plan they compile into, and
      // it names the QA step: the QA runner does not dig through the plan's
      // groups to find it.
      const qaTemplate = await this.catalog.load('pre-merge-qa-verification', { projectRoot: this.projectRoot });
      const qaPlan = this.catalog.compile(qaTemplate);
      const qaStep = this.catalog.selectStep(qaPlan, { kind: 'agent' });
      if (!qaStep || typeof qaStep.prompt !== 'string') {
        throw new Error('pre-merge-qa-verification template must contain an inline agent prompt');
      }

      sandbox = await this.sandboxProvider.create({
        worktreePath,
        session,
        branch: handle.branchName,
        executionMode: this.executionMode,
        tmux: this.executionMode === 'interactive' ? this.tmux : undefined,
        workspaceRoot: this.projectRoot,
        runtimeRunId: getLogContext()?.runId ?? runtimeRunId,
      });
      logger.info({ backlogId: id, session, sandboxId: sandbox.id }, 'QA sandbox created');
      await this.logWorktreeDiagnostics(id, 'before-agent-start', worktreePath);

      const description = backlog.description?.trim();
      const goal = `${qaStep.prompt.replaceAll('{iid}', id)}\n\nBacklog title: ${backlog.title}${description ? `\nBacklog description:\n${description}` : ''}`;
      const prompt = buildExecutionPrompt(goal, this.executionMode, 'qa');
      execution = await this.agentProvider.createExecution({
        sandbox,
        worktreePath,
        sessionId: session,
        prompt,
        signalType: 'goal_complete',
        generation: 1,
        executionMode: this.executionMode,
        runtime: this.agentRuntime,
      });
      await runtime.heartbeat(runtimeFieldsFromExecution(execution.metadata));
      await runtime.heartbeat({ progress: 'QA agent running' });
      logger.info({ backlogId: id, session, event: 'qa-start' }, 'QA verification started');

      const result = await execution.waitForResult({ completionTimeoutMs: this.config.qaTimeout ?? this.config.completionTimeout });
      await this.recordBudgetUsage(budgetStore, budget, execution, result);
      await this.logWorktreeDiagnostics(id, 'agent-completed', worktreePath);
      await runtime.diagnostics({
        result,
        execution,
        failed: { kind: 'error', message: 'QA execution failed' },
        completed: { kind: 'qa', message: 'QA execution completed' },
      });
      logger.info({ backlogId: id, diagnostics: formatExecutionFailure(result) }, 'QA execution result received');
      if (result.status !== 'completed') {
        const summary = `QA ${result.status}: ${formatExecutionFailure(result)}`;
        runtimeErrorSummary = summary;
        await this.handleExecutionFailure(id, worktreePath, session, result, execution);
        return { success: false, summary, failureCode: result.status === 'timed_out' ? 'qa_timeout' : 'qa_execution_failed' };
      }

      const signal = asQAResult(result.structuredOutput);
      if (!signal) {
        const summary = `${formatExecutionFailure(result)}; missing QA completion payload`;
        runtimeErrorSummary = summary;
        await this.markBlocked(id, summary);
        return { success: false, summary, failureCode: 'qa_execution_failed' };
      }
      const outcome = await this.handleQAResult(id, signal, worktreePath, handle.branchName);
      if (!outcome.success) {
        runtimeErrorSummary = outcome.summary ?? (signal.result === 'PASS' ? 'QA terminal routing failed' : signal.summary);
      }
      return outcome;
    } catch (error) {
      const message = `QA execution failed: ${error instanceof Error ? error.message : String(error)}`;
      runtimeErrorSummary = message;
      try {
        await this.markBlocked(id, message);
      } catch (routingError) {
        logger.error({ backlogId: id, error, routingError }, 'QA failure could not be routed to blocked');
        throw error;
      }
      logger.error({ backlogId: id, error }, 'QA execution failed');
      return { success: false, summary: message, failureCode: 'qa_execution_failed' };
    } finally {
      if (execution) await execution.kill().catch(() => {});
      if (sandbox) await sandbox.close().catch(error => logger.warn({ backlogId: id, error }, 'failed to close QA sandbox'));
      if (worktreePath) {
        try {
          await this.providers.branches.cleanup(worktreePath, { preserve: false });
        } catch (error) {
          logger.warn({ backlogId: id, error }, 'failed to clean QA worktree');
        }
      }
      if (workspace) {
        try {
          await workspace.release();
        } catch (error) {
          logger.warn({ backlogId: id, error }, 'failed to release QA workspace');
        }
      }
      const status = runtimeErrorSummary ? 'blocked' : 'completed';
      await runtime.finish({
        status,
        progress: status === 'completed' ? 'QA completed' : 'QA stopped',
        errorSummary: runtimeErrorSummary,
        defaultErrorSummary: QA_RUNTIME_ERROR_SUMMARY,
      });
    }
  }

  /**
   * QA is independently runnable: the managed workspace is released once
   * implementation finishes, so rebuild it when it is gone instead of failing
   * on a missing repository root. A borrowed checkout is restored, one this
   * call created is removed again by release().
   */
  private async prepareWorkspace(id: string): Promise<PreparedRepositorySet | undefined> {
    if (!this.repositories?.length) return undefined;
    const workspace = await this.prepareRepositories.prepare(this.repositories, this.projectRoot);
    logger.info({ backlogId: id, workspace: workspace.primary.handle.path }, 'QA workspace prepared');
    return workspace;
  }

  /** Resolve only an explicit unmerged execution base; parentId remains organizational. */
  private async resolveExecutionBranch(backlog: BacklogItem): Promise<string> {
    const targetBranch = this.config.targetBranch ?? 'main';
    if (!backlog.baseBacklogId) return targetBranch;
    const executionBase = await this.providers.backlog.get(backlog.baseBacklogId);
    return executionBase.state === 'done' ? targetBranch : executionBase.branchName;
  }

  private async mergeBranch(worktreePath: string, baselineBranch: string, featureBranch: string): Promise<void> {
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(worktreePath);
    // Fetch all remote refs before resolving origin/<branch>; a single-branch
    // fetch only guarantees FETCH_HEAD in some Git configurations.
    await git.fetch('origin');
    await git.reset(['--hard', `origin/${baselineBranch}`]);
    await git.merge([`origin/${featureBranch}`, '--no-commit', '--no-ff']);
    logger.info({ worktreePath, baselineBranch, featureBranch }, 'latest baseline and feature merged successfully');
  }

  private async handleExecutionFailure(
    backlogId: string,
    worktreePath: string,
    session: string,
    result: ExecutionResult,
    execution: AgentExecution,
  ): Promise<void> {
    if (result.status === 'timed_out') {
      const snapshot = await execution.captureOutput({ lines: 100, history: 200 });
      await fs.mkdir(this.logDir, { recursive: true });
      await fs.writeFile(`${this.logDir}/timeout-${backlogId}-${Date.now()}.log`, snapshot, 'utf-8');
    }
    await this.markBlocked(backlogId, `QA ${result.status}: ${formatExecutionFailure(result)}`);
    logger.warn({ backlogId, session, worktreePath, diagnostics: formatExecutionFailure(result) }, 'QA execution did not complete');
  }

  private async handleQAResult(
    backlogId: string,
    signal: QAResult,
    worktreePath: string,
    verificationBranch: string,
  ): Promise<QAProcessResult> {
    if (signal.result === 'FAIL') return this.routeQARework(backlogId, signal as QAFailure);

    try {
      const backlog = await this.providers.backlog.get(backlogId);
      const activeRework = await this.providers.backlog.getActiveRework(backlogId);
      const targetBranch = await this.resolveExecutionBranch(backlog);
      await this.beforeChange?.('publish', backlog);
      const commitSha = await this.providers.branches.commit(worktreePath, `QA: verify backlog ${backlogId}`);
      if (commitSha) await this.onCommit?.(commitSha, verificationBranch);
      await this.providers.branches.push(verificationBranch, worktreePath);
      const existing = this.beforeChange ? await this.providers.changes.findForBacklog(backlog) : null;
      if (existing && (existing.state !== 'open' || existing.sourceBranch !== verificationBranch || existing.targetBranch !== targetBranch)) {
        throw new Error(`existing change request ${existing.id} does not match QA branch and target`);
      }
      const mr = existing ?? await this.providers.changes.create({
        backlog, sourceBranch: verificationBranch, targetBranch, draft: false,
      });
      await this.afterPublication?.(mr);
      if (activeRework) {
        await this.providers.backlog.resolveRework(backlogId, activeRework.id, {
          summary: `QA passed after rework ${activeRework.id}.`,
        });
      }
      await this.providers.backlog.transition(backlogId, 'merge_ready', { changeId: String(mr.id) });
      if (!backlog.parentId) {
        await this.providers.backlog.setExecutionMode(backlogId, 'hitl');
        logger.info({ backlogId, changeId: mr.id }, 'root backlog QA passed; awaiting human merge');
        return { success: true, autoMerged: false, mrUrl: mr.url };
      }
      await this.beforeChange?.('merge', backlog, mr);
      await this.providers.changes.merge(String(mr.id));
      await this.providers.backlog.transition(backlogId, 'done', { changeId: String(mr.id) });
      logger.info({ backlogId, changeId: mr.id, targetBranch }, 'child backlog change merged');
      return { success: true, autoMerged: true, mrUrl: mr.url };
    } catch (error) {
      const summary = `QA terminal routing failed: ${error instanceof Error ? error.message : String(error)}`;
      await this.markBlocked(backlogId, summary);
      logger.error({ backlogId, error }, 'QA failed: terminal routing error');
      return { success: false, summary, failureCode: 'provider_change_unconfirmed' };
    }
  }

  private async routeQARework(backlogId: string, signal: QAFailure): Promise<QAProcessResult> {
    const active = await this.providers.backlog.getActiveRework(backlogId);
    const limit = this.config.maxQaReworkAttempts;
    const record: NewReworkRecord = {
      source: 'qa',
      summary: signal.summary,
      failedCriteria: signal.failedCriteria,
      requiredChecks: signal.requiredChecks ?? [],
    };
    const rework = active && active.attempt >= limit ? active : await this.providers.backlog.createRework(backlogId, record);
    if (rework.attempt >= limit) {
      const summary = `QA rework attempt limit reached (${rework.attempt}/${limit}): ${signal.summary}`;
      await this.markBlocked(backlogId, summary);
      return { success: false, summary, failureCode: 'qa_rework', failedCriteria: signal.failedCriteria };
    }
    await this.providers.backlog.transition(backlogId, 'rework', { reason: `QA rework ${rework.id}: ${signal.summary}` });
    await this.providers.backlog.setExecutionMode(backlogId, 'afk');
    logger.info({ backlogId, reworkId: rework.id, attempt: rework.attempt }, 'QA failure persisted rework record');
    return { success: false, rework: true, summary: signal.summary, failureCode: 'qa_rework', failedCriteria: signal.failedCriteria };
  }

  private async markBlocked(backlogId: string, reason: string): Promise<void> {
    await this.providers.backlog.transition(backlogId, 'blocked', { reason });
    await this.providers.backlog.setExecutionMode(backlogId, 'hitl');
  }

  private async recordBudgetUsage(store: BudgetStore, budget: BudgetManager, execution: AgentExecution, result: ExecutionResult): Promise<void> {
    const sandboxKind = sandboxKindOf(this.sandboxProvider.name);
    const telemetry = await collectAgentTelemetry(execution, result, sandboxKind);
    const { sessionId, usage } = telemetry;
    if (usage && budget.recordSession(sessionId, usage.totalTokens)) await store.save(budget.snapshot());
    await this.onSession?.({ kind: 'agent.session_recorded', ...telemetry });
  }

  private async logWorktreeDiagnostics(backlogId: string, phase: string, worktreePath: string): Promise<void> {
    try {
      const diagnostics = await captureWorktreeDiagnostics(worktreePath);
      logger.info({ backlogId, phase, worktreePath, diagnostics }, 'QA worktree diagnostics');
    } catch (error) {
      logger.warn({ backlogId, phase, worktreePath, error }, 'failed to collect QA worktree diagnostics');
    }
  }
}

interface QAResult {
  type: 'goal_complete';
  kind: 'qa';
  result: 'PASS' | 'FAIL';
  summary: string;
  failedCriteria?: QAFailureCriterion[];
  requiredChecks?: Array<{ command: string; expected: string }>;
}

interface QAFailure extends QAResult {
  result: 'FAIL';
  failedCriteria: QAFailureCriterion[];
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseCriteria(value: unknown): QAFailureCriterion[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const criteria = value.map(entry => {
    if (!entry || typeof entry !== 'object') return undefined;
    const item = entry as QAResultObject;
    return nonEmptyString(item.id) && nonEmptyString(item.expected) && nonEmptyString(item.actual)
      ? { id: item.id, expected: item.expected, actual: item.actual }
      : undefined;
  });
  return criteria.some(item => item === undefined) ? undefined : criteria as QAFailureCriterion[];
}

function parseRequiredChecks(value: unknown): Array<{ command: string; expected: string }> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const checks = value.map(entry => {
    if (!entry || typeof entry !== 'object') return undefined;
    const item = entry as QAResultObject;
    return nonEmptyString(item.command) && nonEmptyString(item.expected)
      ? { command: item.command, expected: item.expected }
      : undefined;
  });
  return checks.some(item => item === undefined) ? undefined : checks as Array<{ command: string; expected: string }>;
}

function asQAResult(value: unknown): QAResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const candidate = value as QAResultObject;
  if (
    candidate.type !== 'goal_complete' || candidate.kind !== 'qa' || !nonEmptyString(candidate.summary) ||
    (candidate.result !== 'PASS' && candidate.result !== 'FAIL')
  ) return undefined;
  const requiredChecks = parseRequiredChecks(candidate.requiredChecks);
  if (!requiredChecks) return undefined;
  if (candidate.result === 'FAIL') {
    const failedCriteria = parseCriteria(candidate.failedCriteria);
    if (!failedCriteria) return undefined;
    return { type: 'goal_complete', kind: 'qa', result: 'FAIL', summary: candidate.summary, failedCriteria, requiredChecks };
  }
  return { type: 'goal_complete', kind: 'qa', result: 'PASS', summary: candidate.summary, requiredChecks };
}
