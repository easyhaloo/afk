import { promises as fs } from 'fs';
import { join } from 'path';
import { WorktreeManager } from '../../infrastructure/git/index.js';
import { captureWorktreeDiagnostics } from '../../infrastructure/git/worktree-diagnostics.js';
import { createTmuxClient, type TmuxClient } from '../../infrastructure/tmux/index.js';
import { configureStatusline, logger, getLogContext, resolveQaTimeoutSnapshotDir, withLogContext } from '../../infrastructure/io/index.js';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import { TemplateLoader } from '../../domain/templates/loader.js';
import { blockBacklog } from '../../domain/backlog/commands.js';
import { compileTemplate } from '../../domain/templates/compiler.js';
import { createAgentProvider, resolveAgentProviderName } from '../../domain/agents/index.js';
import { createSandboxProvider } from '../../infrastructure/sandbox/index.js';
import type { AgentProvider, AgentRuntimeSelection, ExecutionMode } from '../../domain/agents/types.js';
import type { AgentExecution, Sandbox, SandboxProvider, ExecutionResult } from '../../infrastructure/sandbox/types.js';
import type { ManagementProviderBundle } from '../../infrastructure/provider/providers.js';
import type { WorkflowConfig } from '../../infrastructure/config/manager.js';
import type { BacklogItem, NewReworkRecord } from '../../domain/backlog/index.js';
import { resolveBacklogExecutionBase } from '../../domain/backlog/creation.js';
import type { ChangeRequest } from '../../infrastructure/tracker/changes/provider.js';
import type { ChangeMergeState } from '../../domain/tracker/types.js';
import type { BaselineMergeResult } from '../../infrastructure/git/branches/provider.js';
import { formatExecutionFailure } from '../workflow-engine.js';
import { buildExecutionPrompt } from '../workflows/execution-protocol.js';
import { TaskRuntimeManager } from '../runtime/task-runtime.js';
import { runtimeFieldsFromExecution, runtimeFieldsFromSelection } from '../runtime/agent-metadata.js';
import { BudgetManager } from '../workflows/budget.js';
import { MultiRepositoryPreparer, type MultiRepositoryPreparationService, type PreparedRepositorySet } from '../workflows/multi-repository-preparer.js';
import type { WorkflowRunRepository } from '../workflows/run-request.js';
import { BudgetStore } from '../workflows/budget-store.js';
import { collectAgentTelemetry } from '../../infrastructure/observability/agent-telemetry.js';
import type { RunEventData } from '@afk/core';

type QAResultObject = { [key: string]: unknown };
type QAFailureCriterion = { id: string; expected: string; actual: string };
type QAProcessResult = { success: boolean; mrUrl?: string; autoMerged?: boolean; rework?: boolean; summary?: string; failureCode?: 'qa_timeout' | 'qa_execution_failed' | 'qa_rework' | 'provider_change_unconfirmed' | 'merge_conflict'; failedCriteria?: QAFailureCriterion[] };

export interface QARunnerDependencies {
  sandboxProvider?: SandboxProvider;
  agentProvider?: AgentProvider;
  agentRuntime?: AgentRuntimeSelection;
  tmux?: TmuxClient;
  executionMode?: ExecutionMode;
  projectRoot?: string;
  /** Managed workspace to run QA against; QA prepares it if it is gone. */
  repositories?: readonly WorkflowRunRepository[];
  /**
   * The baseline the execution declared. A change request has to land on the
   * branch the work was cut from, so a manifest-bound run publishes onto it
   * instead of the globally configured target branch.
   */
  executionBaseBranch?: string;
  prepareRepositories?: MultiRepositoryPreparationService;
  /** Override the merge of the change branch into the target branch. */
  mergeFeatureIntoBaseline?: (
    worktreePath: string,
    baselineBranch: string,
    featureBranch: string,
  ) => Promise<BaselineMergeResult>;
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
  private readonly executionBaseBranch?: string;
  private readonly prepareRepositories: MultiRepositoryPreparationService;
  private readonly mergeFeatureIntoBaselineOverride?: QARunnerDependencies['mergeFeatureIntoBaseline'];
  private readonly runtimeManager: TaskRuntimeManager;
  private readonly beforeChange?: QARunnerDependencies['beforeChange'];
  private readonly afterPublication?: QARunnerDependencies['afterPublication'];
  private readonly onCommit?: QARunnerDependencies['onCommit'];
  private readonly onSession?: QARunnerDependencies['onSession'];

  constructor(providers: ManagementProviderBundle, config?: WorkflowConfig, deps: QARunnerDependencies = {}) {
    this.logDir = resolveQaTimeoutSnapshotDir();
    this.config = config ?? getWorkflowConfig();
    this.providers = providers;
    this.executionMode = deps.executionMode ?? 'batch';
    this.projectRoot = deps.projectRoot ?? process.cwd();
    this.repositories = deps.repositories;
    this.executionBaseBranch = deps.executionBaseBranch;
    this.prepareRepositories = deps.prepareRepositories ?? new MultiRepositoryPreparer();
    this.mergeFeatureIntoBaselineOverride = deps.mergeFeatureIntoBaseline;
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
        return { success: false, summary, failureCode: 'qa_execution_failed' };
      }
      // Merging the change branch into the target branch is where a conflict
      // shows up. It happens before the statusline and the sandbox, so the
      // worktree the agent works in is the merged one.
      const merge = await this.mergeIntoBaseline(worktreePath, baselineBranch, featureBranch);
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

      // A conflict is resolved here, in the QA worktree, which is the change
      // request's own branch — so the resolution lands exactly where the
      // change request is published from.
      if (!merge.merged) {
        const resolution = await this.resolveMergeConflicts(id, worktreePath, session, sandbox, merge.conflicts, baselineBranch);
        if (!resolution.resolved) {
          runtimeErrorSummary = resolution.summary;
          await this.markBlocked(id, resolution.summary);
          return { success: false, summary: resolution.summary, failureCode: 'merge_conflict' };
        }
      }

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

      const result = await execution.waitForResult({ completionTimeoutMs: this.config.qaTimeout ?? this.config.completionTimeout });
      await this.recordBudgetUsage(budgetStore, budget, execution, result);
      await this.logWorktreeDiagnostics(id, 'agent-completed', worktreePath);
      await this.writeRuntimeDiagnostics(runtimeRunId, result, execution);
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
    const configured = this.executionBaseBranch ?? this.config.targetBranch ?? 'main';
    return resolveBacklogExecutionBase(this.providers.backlog, backlog, configured);
  }

  /**
   * Put the target branch in the QA worktree and merge the change branch
   * into it. A conflict is reported, not thrown, so the caller can resolve
   * it in place.
   */
  private async mergeIntoBaseline(
    worktreePath: string,
    baselineBranch: string,
    featureBranch: string,
  ): Promise<BaselineMergeResult> {
    if (this.mergeFeatureIntoBaselineOverride) {
      return await this.mergeFeatureIntoBaselineOverride(worktreePath, baselineBranch, featureBranch);
    }
    return await this.providers.branches.mergeFeatureIntoBaseline(worktreePath, baselineBranch, featureBranch);
  }

  /**
   * Resolve the conflicts between the target branch and the change branch.
   *
   * The worktree is the change request's branch, so resolving here is what
   * makes the change request mergeable. A conflict nobody can resolve — a
   * binary file that both sides changed — is reported to a person instead of
   * being guessed at.
   */
  private async resolveMergeConflicts(
    backlogId: string,
    worktreePath: string,
    session: string,
    sandbox: Sandbox,
    conflicts: string[],
    targetBranch: string,
  ): Promise<{ resolved: boolean; summary: string }> {
    logger.info({ backlogId, worktreePath, targetBranch, conflicts }, 'merge conflict detected; resolving it in the QA worktree');
    const template = await new TemplateLoader({ projectRoot: this.projectRoot }).load('merge-conflict-resolution');
    const step = compileTemplate(template).groups
      .flatMap(group => group.steps)
      .find(candidate => candidate.kind === 'agent');
    if (!step || typeof step.prompt !== 'string') {
      throw new Error('merge-conflict-resolution template must contain an inline agent prompt');
    }
    const goal = step.prompt
      .replaceAll('{targetBranch}', targetBranch)
      .replaceAll('{conflicts}', conflicts.map(file => `- ${file}`).join('\n'));
    const prompt = buildExecutionPrompt(goal, this.executionMode, 'qa');
    const execution = await this.agentProvider.createExecution({
      sandbox,
      worktreePath,
      sessionId: `${session}-conflict`,
      prompt,
      signalType: 'goal_complete',
      generation: 1,
      executionMode: this.executionMode,
      runtime: this.agentRuntime,
    });
    const result = await execution.waitForResult({ completionTimeoutMs: this.config.qaTimeout ?? this.config.completionTimeout });
    const remaining = await this.providers.branches.listUnresolvedConflicts(worktreePath);
    if (remaining.length > 0) {
      const summary = `merge conflict with ${targetBranch} could not be resolved: ${remaining.join(', ')}`;
      logger.warn({ backlogId, worktreePath, remaining, status: result.status }, 'merge conflict resolution left conflicts behind');
      return { resolved: false, summary };
    }
    const commit = await this.providers.branches.commit(worktreePath, `Resolve merge conflict with ${targetBranch}`);
    logger.info({ backlogId, worktreePath, commitSha: commit.sha, skippedBinaryFiles: commit.skippedBinaryFiles }, 'merge conflict resolved');
    return { resolved: true, summary: `resolved ${conflicts.length} merge conflict(s) with ${targetBranch}` };
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
      await fs.writeFile(join(this.logDir, `timeout-${backlogId}-${Date.now()}.log`), snapshot, 'utf-8');
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
      const commit = await this.providers.branches.commit(worktreePath, `QA: verify backlog ${backlogId}`);
      const commitSha = commit.sha;
      if (commit.skippedBinaryFiles.length > 0) {
        logger.warn({ backlogId, worktreePath, skippedBinaryFiles: commit.skippedBinaryFiles },
          'binary files left out of the QA commit');
      }
      if (commitSha) await this.onCommit?.(commitSha, verificationBranch);
      await this.providers.branches.push(verificationBranch, worktreePath);
      const existing = this.beforeChange ? await this.providers.changes.findForBacklog(backlog) : null;
      if (existing && (existing.state !== 'open' || existing.sourceBranch !== verificationBranch || existing.targetBranch !== targetBranch)) {
        throw new Error(`existing change request ${existing.id} does not match QA branch and target`);
      }
      await this.recordArtifactManifest(backlogId, worktreePath);
      const evidence = {
        summary: signal.summary,
        checks: signal.requiredChecks,
        observations: signal.observations,
        notes: signal.notes,
      };
      let mr = existing;
      if (mr) {
        // A previous attempt left the review request behind. The evidence in
        // its body is the evidence of that attempt, so it is refreshed with
        // the one this attempt gathered.
        mr = await this.providers.changes.refresh?.(mr.id, backlog, evidence) ?? mr;
      } else {
        mr = await this.providers.changes.create({
          backlog, sourceBranch: verificationBranch, targetBranch, draft: false,
          evidence,
          worktreePath,
          commitSha: commitSha || undefined,
        });
      }
      await this.afterPublication?.(mr);
      if (activeRework) {
        await this.providers.backlog.resolveRework(backlogId, activeRework.id, {
          summary: `QA passed after rework ${activeRework.id}.`,
        });
      }
      // The change request is only ready for a person when the platform says
      // it can land. A conflict means the target branch moved under the
      // change, so the change goes back for another round instead of being
      // handed over as something a person can merge.
      const conflict = await this.detectPublishedConflict(mr);
      if (conflict) {
        const summary = `change request ${mr.id} conflicts with ${targetBranch}: ${conflict}`;
        const rework = await this.openConflictRework(backlogId, summary);
        if (!rework) {
          await this.markBlocked(backlogId, summary);
          return { success: false, summary, failureCode: 'merge_conflict' };
        }
        logger.warn({ backlogId, changeId: mr.id, reworkId: rework.id, conflict }, 'published change request conflicts with the target branch');
        return { success: false, rework: true, summary, failureCode: 'merge_conflict' };
      }
      await this.providers.backlog.transition(backlogId, 'merge_ready', { changeId: String(mr.id) });
      // Merging is a person's decision. AFK implements, verifies and
      // publishes the change; the merge waits for a human to confirm it.
      // Only an installation that asks for the merge to happen on its own
      // merges here, and a root backlog never merges itself either — its
      // change is the one the whole set of slices hangs on.
      if (!backlog.parentId || !this.config.autoMerge) {
        await this.providers.backlog.setExecutionMode(backlogId, 'hitl');
        logger.info({ backlogId, changeId: mr.id }, 'change published; awaiting human merge');
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

  /**
   * Leave a trace when a QA run published no binary evidence. A missing
   * `.afk/artifacts.txt` is not a failure — a run may produce no artifacts —
   * but it must not look like a verified run with attachments.
   */
  private async recordArtifactManifest(backlogId: string, worktreePath: string): Promise<void> {
    const marker = join(worktreePath, '.afk', 'artifacts.txt');
    try {
      const content = await fs.readFile(marker, 'utf-8');
      const paths = content.split('\n').map(line => line.trim()).filter(Boolean);
      logger.info({ backlogId, worktreePath, artifacts: paths.length }, 'QA artifact manifest found');
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn({ backlogId, worktreePath, error }, 'failed to read the QA artifact manifest');
        return;
      }
    }
    logger.warn({ backlogId, worktreePath }, 'QA published no artifact manifest; no binary evidence was registered');
    const runId = getLogContext()?.runId;
    if (!runId) return;
    try {
      await this.runtimeManager.appendActivity(runId, {
        kind: 'qa',
        message: 'no artifact manifest was registered for this QA run',
        detail: `Expected ${marker} to list the binary evidence of the run.`,
      });
    } catch (error) {
      logger.warn({ runId, error }, 'failed to record the missing QA artifact manifest');
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
    await blockBacklog(this.providers.backlog, backlogId, reason);
  }

  /**
   * Ask the platform whether the published change request can land.
   *
   * Only a real conflict counts. A verdict the platform has not computed yet,
   * or a reason that is not a conflict — a failing check, a missing
   * approval — leaves the change as it is.
   */
  private async detectPublishedConflict(mr: ChangeRequest): Promise<string | undefined> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let state: ChangeMergeState | undefined;
      try {
        state = (await this.providers.changes.get(String(mr.id))).mergeState;
      } catch (error) {
        logger.warn({ changeId: mr.id, error }, 'could not read the merge state of the published change request');
        return undefined;
      }
      if (state === 'conflict') return 'the target branch changed the same lines';
      if (state === 'mergeable') return undefined;
      // The platform has not settled on a verdict yet. Give it a moment.
      await new Promise(resolve => setTimeout(resolve, 1_500));
    }
    return undefined;
  }

  /**
   * Send the change back for another round.
   *
   * The rework record carries the conflict, so the next round knows what it
   * has to make compatible. A conflict that outlives the attempt limit goes
   * to a person instead.
   */
  private async openConflictRework(
    backlogId: string,
    summary: string,
  ): Promise<{ id: string; attempt: number } | undefined> {
    const limit = this.config.maxQaReworkAttempts ?? 3;
    const active = await this.providers.backlog.getActiveRework(backlogId);
    if (active && active.attempt >= limit) return undefined;
    let rework: { id: string; attempt: number };
    try {
      rework = await this.providers.backlog.createRework(backlogId, {
        source: 'conflict',
        summary,
        failedCriteria: [],
        requiredChecks: [],
      });
    } catch (error) {
      logger.warn({ backlogId, error }, 'could not open a conflict rework record');
      return undefined;
    }
    await this.providers.backlog.transition(backlogId, 'rework', { reason: summary });
    await this.providers.backlog.setExecutionMode(backlogId, 'afk');
    return rework;
  }

  private async recordBudgetUsage(store: BudgetStore, budget: BudgetManager, execution: AgentExecution, result: ExecutionResult): Promise<void> {
    const sandboxKind = this.sandboxProvider.name === 'docker' || this.sandboxProvider.name === 'podman' ? 'container' : 'local';
    const telemetry = await collectAgentTelemetry(execution, result, sandboxKind);
    const { sessionId, usage } = telemetry;
    if (usage && budget.recordSession(sessionId, usage.totalTokens)) await store.save(budget.snapshot());
    await this.onSession?.({ kind: 'agent.session_recorded', ...telemetry });
  }

  private async startRuntime(runId: string, backlog: BacklogItem, session: string): Promise<void> {
    const now = new Date().toISOString();
    try {
      await this.runtimeManager.start({
        runId,
        // The runtime record is keyed by the provider-local issue number, the
        // same key the implementation phase writes, so Desktop can join both
        // phases of one execution.
        backlogId: String(backlog.issueNumber ?? backlog.id),
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
  requiredChecks?: Array<{ command: string; expected: string; actual?: string }>;
  observations?: Array<{ claim: string; evidence?: string }>;
  notes?: string;
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

function parseRequiredChecks(value: unknown): Array<{ command: string; expected: string; actual?: string }> | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const checks = value.map(entry => {
    if (!entry || typeof entry !== 'object') return undefined;
    const item = entry as QAResultObject;
    if (!nonEmptyString(item.command) || !nonEmptyString(item.expected)) return undefined;
    const actual = nonEmptyString(item.actual) ? item.actual : undefined;
    return { command: item.command, expected: item.expected, ...(actual ? { actual } : {}) };
  });
  return checks.some(item => item === undefined) ? undefined : checks as Array<{ command: string; expected: string; actual?: string }>;
}

/**
 * Observations and notes are extra reporting detail, not the QA verdict. A
 * malformed entry is dropped so it can never invalidate a result the agent
 * already proved.
 */
function parseObservations(value: unknown): Array<{ claim: string; evidence?: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const observations = value.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as QAResultObject;
    if (!nonEmptyString(item.claim)) return [];
    const evidence = nonEmptyString(item.evidence) ? item.evidence : undefined;
    return [{ claim: item.claim, ...(evidence ? { evidence } : {}) }];
  });
  return observations.length ? observations : undefined;
}

function parseNotes(value: unknown): string | undefined {
  return nonEmptyString(value) ? value : undefined;
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
  const observations = parseObservations(candidate.observations);
  const notes = parseNotes(candidate.notes);
  const detail = { ...(observations ? { observations } : {}), ...(notes ? { notes } : {}) };
  if (candidate.result === 'FAIL') {
    const failedCriteria = parseCriteria(candidate.failedCriteria);
    if (!failedCriteria) return undefined;
    return { type: 'goal_complete', kind: 'qa', result: 'FAIL', summary: candidate.summary, failedCriteria, requiredChecks, ...detail };
  }
  return { type: 'goal_complete', kind: 'qa', result: 'PASS', summary: candidate.summary, requiredChecks, ...detail };
}
