import { promises as fs } from 'fs';
import { WorktreeManager } from '../../infrastructure/git/index.js';
import { captureWorktreeDiagnostics } from '../../infrastructure/git/worktree-diagnostics.js';
import { createTmuxClient, type TmuxClient } from '../../infrastructure/tmux/index.js';
import { configureStatusline, logger, getLogContext, withLogContext } from '../../infrastructure/io/index.js';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import { TemplateLoader } from '../../domain/templates/loader.js';
import { compileTemplate } from '../../domain/templates/compiler.js';
import { createAgentProvider, resolveAgentProviderName } from '../../domain/agents/index.js';
import { createSandboxProvider } from '../../infrastructure/sandbox/index.js';
import type { AgentProvider, AgentRuntimeSelection, ExecutionMode } from '../../domain/agents/types.js';
import type { AgentExecution, Sandbox, SandboxProvider, ExecutionResult } from '../../infrastructure/sandbox/types.js';
import type { ManagementProviderBundle } from '../../infrastructure/provider/providers.js';
import type { WorkflowConfig } from '../../infrastructure/config/manager.js';
import type { BacklogItem, NewReworkRecord } from '../../domain/backlog/index.js';
import type { ChangeRequest } from '../../infrastructure/tracker/changes/provider.js';
import { formatExecutionFailure } from '../workflow-engine.js';
import { buildExecutionPrompt } from '../workflows/execution-protocol.js';
import { TaskRuntimeManager } from '../runtime/task-runtime.js';
import { runtimeFieldsFromExecution, runtimeFieldsFromSelection } from '../runtime/agent-metadata.js';
import { BudgetManager } from '../workflows/budget.js';
import { MultiRepositoryPreparer, type MultiRepositoryPreparationService, type PreparedRepositorySet } from '../workflows/multi-repository-preparer.js';
import type { WorkflowRunRepository } from '../workflows/run-request.js';
import { BudgetStore } from '../workflows/budget-store.js';
import { findCodexRollout, readAgentTelemetry, readAgentTools } from '../../infrastructure/observability/agent-telemetry.js';
import type { RunEventData } from '@afk/core';

type QAResultObject = { [key: string]: unknown };
type QAFailureCriterion = { id: string; expected: string; actual: string };
type QAProcessResult = { success: boolean; mrUrl?: string; autoMerged?: boolean; rework?: boolean; summary?: string; failedCriteria?: QAFailureCriterion[] };

export interface QARunnerDependencies {
  sandboxProvider?: SandboxProvider;
  agentProvider?: AgentProvider;
  agentRuntime?: AgentRuntimeSelection;
  tmux?: TmuxClient;
  executionMode?: ExecutionMode;
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
  private readonly executionMode: ExecutionMode;
  private readonly projectRoot: string;
  private readonly repositories?: readonly WorkflowRunRepository[];
  private readonly prepareRepositories: MultiRepositoryPreparationService;
  private readonly mergeBranchOverride?: (worktreePath: string, baselineBranch: string, featureBranch: string) => Promise<void>;
  private readonly runtimeManager: TaskRuntimeManager;
  private readonly beforeChange?: QARunnerDependencies['beforeChange'];
  private readonly afterPublication?: QARunnerDependencies['afterPublication'];
  private readonly onCommit?: QARunnerDependencies['onCommit'];
  private readonly onSession?: QARunnerDependencies['onSession'];

  constructor(providers: ManagementProviderBundle, config?: WorkflowConfig, deps: QARunnerDependencies = {}) {
    this.logDir = `${process.env.HOME}/.claude/logs/afk/qa`;
    this.config = config ?? getWorkflowConfig();
    this.providers = providers;
    this.executionMode = deps.executionMode ?? 'batch';
    this.projectRoot = deps.projectRoot ?? process.cwd();
    this.repositories = deps.repositories;
    this.prepareRepositories = deps.prepareRepositories ?? new MultiRepositoryPreparer();
    this.mergeBranchOverride = deps.mergeBranch;
    this.runtimeManager = deps.runtimeManager ?? new TaskRuntimeManager();
    this.beforeChange = deps.beforeChange;
    this.afterPublication = deps.afterPublication;
    this.onCommit = deps.onCommit;
    this.onSession = deps.onSession;
    this.sandboxProvider = deps.sandboxProvider ?? createSandboxProvider('local', { worktreeManager: new WorktreeManager() });
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
    let runtimeStarted = false;
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
      await this.startRuntime(runtimeRunId, backlog, session);
      runtimeStarted = true;
      workspace = await this.prepareWorkspace(id);
      const handle = await this.providers.branches.createVerificationWorktree(backlog, baselineBranch);
      worktreePath = handle.worktreePath;
      await this.logWorktreeDiagnostics(id, 'worktree-created', worktreePath);
      await this.heartbeatRuntime(runtimeRunId, { worktree: worktreePath, branch: handle.branchName, progress: 'QA worktree created' });
      logger.info({ backlogId: id, worktree: worktreePath, baselineBranch }, 'QA worktree created');

      const featureBranch = backlog.branchName;
      if (!featureBranch) {
        const summary = 'QA execution failed: feature branch could not be resolved';
        await this.markBlocked(id, summary);
        return { success: false, summary };
      }
      if (this.mergeBranchOverride) await this.mergeBranchOverride(worktreePath, baselineBranch, featureBranch);
      else await this.mergeBranch(worktreePath, baselineBranch, featureBranch);
      await this.logWorktreeDiagnostics(id, 'branches-merged', worktreePath);
      if (this.executionMode === 'interactive') {
        await configureStatusline(worktreePath);
        await this.logWorktreeDiagnostics(id, 'statusline-configured', worktreePath);
      }

      const qaTemplate = await new TemplateLoader({ projectRoot: this.projectRoot }).load('pre-merge-qa-verification');
      const qaStep = compileTemplate(qaTemplate).groups
        .flatMap(group => group.steps)
        .find(step => step.kind === 'agent');
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
      await this.heartbeatRuntime(runtimeRunId, runtimeFieldsFromExecution(execution.metadata));
      await this.heartbeatRuntime(runtimeRunId, { progress: 'QA agent running' });
      logger.info({ backlogId: id, session, event: 'qa-start' }, 'QA verification started');

      const result = await execution.waitForResult({ completionTimeoutMs: this.config.completionTimeout });
      await this.recordBudgetUsage(budgetStore, budget, execution, result);
      await this.logWorktreeDiagnostics(id, 'agent-completed', worktreePath);
      await this.writeRuntimeDiagnostics(runtimeRunId, result, execution);
      logger.info({ backlogId: id, diagnostics: formatExecutionFailure(result) }, 'QA execution result received');
      if (result.status !== 'completed') {
        const summary = `QA ${result.status}: ${formatExecutionFailure(result)}`;
        runtimeErrorSummary = summary;
        await this.handleExecutionFailure(id, worktreePath, session, result, execution);
        return { success: false, summary };
      }

      const signal = asQAResult(result.structuredOutput);
      if (!signal) {
        const summary = `${formatExecutionFailure(result)}; missing QA completion payload`;
        runtimeErrorSummary = summary;
        await this.markBlocked(id, summary);
        return { success: false, summary };
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
      return { success: false, summary: message };
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
      if (runtimeStarted) {
        await this.finishRuntime(runtimeRunId, runtimeErrorSummary ? 'blocked' : 'completed', runtimeErrorSummary);
      }
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
      return { success: false, summary };
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
      return { success: false, summary, failedCriteria: signal.failedCriteria };
    }
    await this.providers.backlog.transition(backlogId, 'rework', { reason: `QA rework ${rework.id}: ${signal.summary}` });
    await this.providers.backlog.setExecutionMode(backlogId, 'afk');
    logger.info({ backlogId, reworkId: rework.id, attempt: rework.attempt }, 'QA failure persisted rework record');
    return { success: false, rework: true, summary: signal.summary, failedCriteria: signal.failedCriteria };
  }

  private async markBlocked(backlogId: string, reason: string): Promise<void> {
    await this.providers.backlog.transition(backlogId, 'blocked', { reason });
    await this.providers.backlog.setExecutionMode(backlogId, 'hitl');
  }

  private async recordBudgetUsage(store: BudgetStore, budget: BudgetManager, execution: AgentExecution, result: ExecutionResult): Promise<void> {
    let usage = result.usage;
    let tools = result.tools;
    if ((!usage || !tools) && this.sandboxProvider.name !== 'docker' && this.sandboxProvider.name !== 'podman') {
      let transcriptPath: string | undefined;
      if (this.agentProvider.name === 'codex') {
        const threadId = execution.metadata.threadId;
        if (threadId) transcriptPath = await findCodexRollout(threadId);
      } else {
        transcriptPath = (execution as { telemetryPath?: string }).telemetryPath;
      }
      if (transcriptPath) {
        const options = { provider: this.agentProvider.name === 'codex' ? 'codex' as const : 'claude-code' as const, transcriptPath, sandboxKind: 'local' as const };
        if (!usage) usage = await readAgentTelemetry(options);
        if (!tools) tools = await readAgentTools(options);
      }
    }
    const sessionId = execution.metadata.threadId ?? result.sessionId ?? execution.id;
    if (usage && budget.recordSession(sessionId, usage.totalTokens)) await store.save(budget.snapshot());
    await this.onSession?.({ kind: 'agent.session_recorded', sessionId, usage, tools });
  }

  private async startRuntime(runId: string, backlog: BacklogItem, session: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.runtimeManager.start({
        runId,
        backlogId: backlog.id,
        workspace: this.projectRoot,
        providerRef: backlog.providerRef,
        title: backlog.title,
        phase: 'verifying',
        status: 'running',
        sandboxProvider: this.sandboxProvider.name,
        executionMode: this.executionMode,
        agentProvider: this.agentProvider.name,
        ...runtimeFieldsFromSelection(this.agentProvider.name, this.agentRuntime),
        session: this.executionMode === 'interactive' ? session : undefined,
        branch: backlog.branchName,
        startedAt: now,
        heartbeatAt: now,
        progress: 'QA starting',
      });
    } catch (error) {
      logger.warn({ backlogId: backlog.id, error }, 'failed to publish QA runtime');
    }
  }

  private async heartbeatRuntime(runId: string, changes: Parameters<TaskRuntimeManager['heartbeat']>[1]): Promise<void> {
    try {
      await this.runtimeManager.heartbeat(runId, changes);
    } catch (error) {
      logger.warn({ runId, error }, 'failed to update QA runtime');
    }
  }

  private async finishRuntime(runId: string, status: 'completed' | 'blocked', errorSummary?: string): Promise<void> {
    try {
      await this.runtimeManager.finish(runId, {
        status,
        progress: status === 'completed' ? 'QA completed' : 'QA stopped',
        errorSummary,
      });
    } catch (error) {
      logger.warn({ runId, error }, 'failed to archive QA runtime');
    }
  }

  private async writeRuntimeDiagnostics(runId: string, result: ExecutionResult, execution: AgentExecution): Promise<void> {
    try {
      const output = await execution.captureOutput({ lines: 200, history: 2_000 });
      await this.runtimeManager.writeDiagnostics(runId, { result, output });
      const structured = result.structuredOutput as { result?: string; summary?: string } | undefined;
      const failed = result.status !== 'completed' || structured?.result === 'FAIL';
      await this.runtimeManager.appendActivity(runId, {
        kind: failed ? 'error' : 'qa',
        message: structured?.summary ?? (failed ? 'QA execution failed' : 'QA execution completed'),
      });
    } catch (error) {
      logger.warn({ runId, error }, 'failed to persist QA runtime diagnostics');
    }
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
