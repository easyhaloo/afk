import { promises as fs } from 'fs';
import { join } from 'path';
import { WorktreeManager } from '../../infrastructure/git/index.js';
import { captureWorktreeDiagnostics } from '../../infrastructure/git/worktree-diagnostics.js';
import { createTmuxClient, type TmuxClient } from '../../infrastructure/tmux/index.js';
import { configureStatusline, logger, getLogContext, resolveQaTimeoutSnapshotDir, withLogContext } from '../../infrastructure/io/index.js';
import { getWorkflowConfig, repositoryExecutionDefaults } from '../../infrastructure/config/manager.js';
import { TemplateLoader } from '../../domain/templates/loader.js';
import { blockBacklog } from '../../domain/backlog/commands.js';
import { compileTemplate } from '../../domain/templates/compiler.js';
import { AgentProviderRegistry, defaultAgentProviderRegistry, ensureBuiltinAgentProviders } from '../../domain/agents/index.js';
import { prepareAgentRuntime } from '../../domain/agents/codex-runtime.js';
import { resolveRuntimeForProvider } from '../../domain/agents/runtime-binding.js';
import { createSandboxProvider } from '../../infrastructure/sandbox/index.js';
import type { AgentProvider, AgentRuntimeSelection, ExecutionMode } from '../../domain/agents/types.js';
import type { AgentExecution, Sandbox, SandboxProvider, ExecutionResult } from '../../infrastructure/sandbox/types.js';
import type { ManagementProviderBundle } from '../../infrastructure/provider/providers.js';
import type { WorkflowConfig } from '../../infrastructure/config/manager.js';
import { parseWorkItemId, type BacklogItem, type NewReworkRecord } from '../../domain/backlog/index.js';
import { createExecutionPlan, parseExecutionPlan, type ExecutionPlan } from '../../domain/backlog/execution-plan.js';
import { resolveParentPrdBaseline, resolvePrdExecutionPlan } from '../../domain/backlog/prd-baseline.js';
import type { ChangeRequest } from '../../infrastructure/tracker/changes/provider.js';
import type { ChangeMergeState } from '../../domain/tracker/types.js';
import { decideMergeVerdict } from '../../domain/branches/publish-boundary.js';
import type { BaselineMergeResult } from '../../infrastructure/git/branches/provider.js';
import { formatExecutionFailure, formatExecutionFailureReport } from '../workflow-engine.js';
import { diagnoseExecutionFailure, createFailureDiagnostic, type FailureDiagnostic, type FailureEvidence } from '../workflows/failure-diagnostic.js';
import { assemblePrompt, buildExecutionPromptSegments, type PromptSegment } from '../workflows/execution-protocol.js';
import { BACKLOG_CONTEXT_PATH, buildGoalSegments, writeBacklogContext } from '../workflows/backlog-context.js';
import { prepareExperienceContext } from '../learning/runtime.js';
import { measurePromptBudget } from '../../domain/agents/prompt-budget.js';
import { TaskRuntimeManager } from '../runtime/task-runtime.js';
import { runtimeFieldsFromExecution, runtimeFieldsFromSelection } from '../runtime/agent-metadata.js';
import { BudgetManager } from '../workflows/budget.js';
import { MultiRepositoryPreparer, type MultiRepositoryPreparationService, type PreparedRepositorySet } from '../workflows/multi-repository-preparer.js';
import type { WorkflowRunRepository } from '../workflows/run-request.js';
import { BudgetStore } from '../workflows/budget-store.js';
import { RunResourceScope } from '../workflows/resource-scope.js';
import { collectAgentTelemetry } from '../../infrastructure/observability/agent-telemetry.js';
import { runQaPreflight } from './qa-preflight.js';
import { LifecycleDispatcher, type LifecycleContext } from '../workflows/lifecycle.js';
import type { PluginRuntime } from '../plugins/runtime.js';
import type { RunEventData, RunFailureReasonCode } from '@afk/core';

type QAResultObject = { [key: string]: unknown };
type QAFailureCriterion = { id: string; expected: string; actual: string };
type QAProcessResult = { success: boolean; mrUrl?: string; rework?: boolean; summary?: string; failureCode?: RunFailureReasonCode; failedCriteria?: QAFailureCriterion[]; evidence?: FailureEvidence[] };

/**
 * What the platform said about a published change request.
 *
 * The three answers are not the same kind of news:
 *
 * - `accept` — the change request can land, or the platform has not
 *   settled on a verdict yet. Either way AFK has nothing to act on.
 * - `conflict` — the content conflicts. Another round of work can resolve
 *   it.
 * - `baseline_advanced` — the target branch already carries the change, so
 *   there is nothing left to merge. The baseline moved; the content did
 *   not conflict. Another round of work cannot resolve this, because the
 *   work is already in the baseline and doing it again would move the
 *   baseline again. A person decides.
 */
type PublicationVerdict =
  | { kind: 'accept' }
  | { kind: 'conflict'; detail: string }
  | { kind: 'baseline_advanced'; detail: string };

export interface QARunnerDependencies {
  sandboxProvider?: SandboxProvider;
  agentProvider?: AgentProvider;
  agentProviderRegistry?: AgentProviderRegistry;
  plugins?: PluginRuntime;
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
  executionPlan?: ExecutionPlan;
  prepareRepositories?: MultiRepositoryPreparationService;
  /** Override the merge of the change branch into the target branch. */
  mergeFeatureIntoBaseline?: (
    worktreePath: string,
    baselineBranch: string,
    featureBranch: string,
  ) => Promise<BaselineMergeResult>;
  runtimeManager?: TaskRuntimeManager;
  /**
   * Readiness probe for a runtime the runner resolved itself (tests).
   * Defaults to AFK's Codex readiness probe, which spends a live model
   * round-trip.
   */
  prepareRuntime?: (runtime: AgentRuntimeSelection) => Promise<AgentRuntimeSelection>;
  beforeChange?: (action: 'publish', backlog: BacklogItem) => Promise<void>;
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
  private agentRuntime?: AgentRuntimeSelection;
  /**
   * A runtime the runner resolved itself has not been probed yet.
   *
   * The CLI and the work-item runner both probe the runtime before they
   * hand it over, so an injected runtime is already probed. A runtime
   * resolved here — because the reviewer runs a provider the caller did
   * not name — is probed here, so an unreachable model fails with the
   * probe's own diagnosis instead of a transport error from the wrong
   * endpoint.
   */
  private runtimeNeedsProbe: boolean;
  private readonly tmux?: TmuxClient;
  private readonly executionMode: ExecutionMode;
  private readonly projectRoot: string;
  private readonly repositories?: readonly WorkflowRunRepository[];
  private readonly executionBaseBranch?: string;
  private readonly executionPlan?: ExecutionPlan;
  private readonly prepareRepositories: MultiRepositoryPreparationService;
  private readonly mergeFeatureIntoBaselineOverride?: QARunnerDependencies['mergeFeatureIntoBaseline'];
  private readonly runtimeManager: TaskRuntimeManager;
  private readonly prepareRuntime: (runtime: AgentRuntimeSelection) => Promise<AgentRuntimeSelection>;
  private readonly beforeChange?: QARunnerDependencies['beforeChange'];
  private readonly afterPublication?: QARunnerDependencies['afterPublication'];
  private readonly onCommit?: QARunnerDependencies['onCommit'];
  private readonly onSession?: QARunnerDependencies['onSession'];
  private readonly agentProviderRegistry: AgentProviderRegistry;
  private readonly plugins?: PluginRuntime;
  private activeConflictExecution?: AgentExecution;
  private leaseFailure?: unknown;

  constructor(providers: ManagementProviderBundle, config?: WorkflowConfig, deps: QARunnerDependencies = {}) {
    this.logDir = resolveQaTimeoutSnapshotDir();
    this.config = config ?? getWorkflowConfig();
    this.providers = providers;
    this.executionMode = deps.executionMode ?? 'batch';
    this.projectRoot = deps.projectRoot ?? process.cwd();
    this.repositories = deps.repositories;
    this.executionBaseBranch = deps.executionBaseBranch;
    this.executionPlan = deps.executionPlan;
    this.prepareRepositories = deps.prepareRepositories ?? new MultiRepositoryPreparer();
    this.mergeFeatureIntoBaselineOverride = deps.mergeFeatureIntoBaseline;
    this.runtimeManager = deps.runtimeManager ?? new TaskRuntimeManager();
    this.beforeChange = deps.beforeChange;
    this.afterPublication = deps.afterPublication;
    this.onCommit = deps.onCommit;
    this.onSession = deps.onSession;
    this.plugins = deps.plugins;
    this.agentProviderRegistry = deps.agentProviderRegistry ?? deps.plugins?.getAgentProviderRegistry() ?? defaultAgentProviderRegistry;
    if (!deps.agentProviderRegistry && !deps.plugins) ensureBuiltinAgentProviders(this.agentProviderRegistry);
    this.sandboxProvider = deps.sandboxProvider ?? (deps.plugins
      ? deps.plugins.getSandboxProviderRegistry().create('local', { worktreeManager: new WorktreeManager() })
      : createSandboxProvider('local', { worktreeManager: new WorktreeManager() }));
    this.agentProvider = deps.agentProvider ?? this.agentProviderRegistry.require(this.config.agentDefault ?? 'claude-code');
    // The reviewer runs a provider, and a provider runs with a runtime: the
    // two are one decision. A reviewer that resolves its own provider —
    // from AFK's configuration — must resolve the runtime that belongs to
    // it as well. Without this, a Codex reviewer runs with no runtime at
    // all: no profile, no provider, no transport, so Codex falls back to
    // the host's own configuration and talks to an endpoint nobody chose.
    const bound = resolveRuntimeForProvider({
      provider: this.agentProvider.name,
      runtime: deps.agentRuntime,
      codex: this.config.agents?.codex,
    });
    this.agentRuntime = bound;
    this.runtimeNeedsProbe = bound !== undefined && bound !== deps.agentRuntime;
    this.prepareRuntime = deps.prepareRuntime ?? prepareAgentRuntime;
    this.tmux = deps.tmux ?? (this.executionMode === 'interactive' ? createTmuxClient() : undefined);
  }

  async process(backlogId: string): Promise<QAProcessResult> {
    const id = String(backlogId);
    const session = `qa-${id}-${Date.now()}`;
    return withLogContext(getLogContext() ?? { runId: `${session}-runtime`, workItemId: id }, () => this.processObserved(id, session));
  }

  /**
   * Probe a runtime the runner resolved itself, once, before the agent runs.
   *
   * An injected runtime was probed by the caller; probing it again would
   * spend a second live model round-trip for an answer AFK already has.
   */
  private async probeOwnRuntime(): Promise<void> {
    if (!this.runtimeNeedsProbe || this.agentRuntime?.kind !== 'codex') return;
    this.agentRuntime = await this.prepareRuntime(this.agentRuntime);
    this.runtimeNeedsProbe = false;
  }

  private async processObserved(id: string, session: string): Promise<QAProcessResult> {
    logger.info({ backlogId: id, executionMode: this.executionMode }, 'QA processing started');
    let worktreePath: string | undefined;
    let sandbox: Sandbox | undefined;
    let execution: AgentExecution | undefined;
    let workspace: PreparedRepositorySet | undefined;
    let lifecycle: LifecycleDispatcher | undefined;
    let lifecycleContext: LifecycleContext | undefined;
    const runtimeRunId = `${session}-runtime`;
    let runtimeStarted = false;
    let runtimeErrorSummary: string | undefined;
    let leaseError: unknown;
    this.leaseFailure = undefined;
    const leaseScope = new RunResourceScope({ repoRoot: this.projectRoot, baseBranch: 'main', managePrimary: false });

    try {
      const backlog = await this.providers.backlog.get(id);
      if (backlog.state !== 'verification') throw new Error(`QA for ${id} requires verification state`);
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
      const dispatcher = new LifecycleDispatcher(this.plugins?.getLifecycleModules());
      lifecycle = dispatcher;
      const lifecycleBase = {
        iid: backlog.issueNumber ?? (/^[1-9]\d*$/.test(backlog.id)
          ? Number(backlog.id) : parseWorkItemId(backlog.workItemId ?? backlog.id).issueNumber),
        baseBranch: baselineBranch,
        params: {},
        originalCwd: this.projectRoot,
        repoRoot: workspace?.primary.repoRoot ?? this.projectRoot,
        repositories: workspace?.repositories,
      };
      await dispatcher.run('init', { ...lifecycleBase, projectName: undefined });
      const heartbeat = async () => {
        await workspace?.heartbeat?.();
        const current = await this.providers.backlog.get(id);
        if (current.state !== 'verification') throw new Error(`QA for ${id} was interrupted`);
      };
      leaseScope.registerHeartbeat(heartbeat, 10_000, async error => {
        leaseError = error;
        this.leaseFailure = error;
        await Promise.all([execution?.kill(), this.activeConflictExecution?.kill()]);
      });
      const handle = await this.providers.branches.createVerificationWorktree(backlog, baselineBranch);
      worktreePath = handle.worktreePath;
      const context = { ...lifecycleBase, worktreePath, sessionName: session };
      lifecycleContext = context;
      await dispatcher.run('before-agent', context);
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

      const qaTemplate = await new TemplateLoader({ projectRoot: this.projectRoot, getPluginTemplate: name => this.plugins?.getTemplate(name) }).load('pre-merge-qa-verification');
      const qaSteps = compileTemplate(qaTemplate).groups.flatMap(group => group.steps);
      const [qaStep] = qaSteps;
      if (qaSteps.length !== 1 || !qaStep || qaStep.kind !== 'agent' || typeof qaStep.prompt !== 'string') {
        throw new Error('pre-merge-qa-verification template must contain exactly one inline agent step');
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
      // The reviewer is about to start. A runtime the runner resolved itself
      // is probed first, so an unreachable model fails here — with the
      // probe's own diagnosis — instead of halfway through the first turn.
      await this.probeOwnRuntime();

      // A conflict is resolved here, in the QA worktree, which is the change
      // request's own branch — so the resolution lands exactly where the
      // change request is published from.
      if (!merge.merged) {
        const resolution = await this.resolveMergeConflicts(id, worktreePath, session, merge.conflicts, baselineBranch);
        if (!resolution.resolved) {
          runtimeErrorSummary = resolution.summary;
          await this.markBlocked(id, resolution.summary);
          return { success: false, summary: resolution.summary, failureCode: resolution.failureCode ?? 'merge_conflict' };
        }
      }

      const description = backlog.description?.trim();
      // The verification agent is about to be asked to settle criteria that
      // name their own check commands. If this machine cannot run those
      // commands, the agent would spend the whole round finding that out.
      const preflight = await runQaPreflight(
        { description: backlog.description, tags: backlog.tags },
        worktreePath,
      );
      if (preflight.blocked) {
        runtimeErrorSummary = preflight.summary;
        logger.warn({ backlogId: id, blockers: preflight.blockers }, 'QA environment cannot run the acceptance criteria');
        // An environment declaration, not a verdict on the criteria: the
        // probes it ran travel with it so the reader can tell the two apart.
        const declaration = createFailureDiagnostic({
          code: 'qa_environment_missing',
          message: preflight.summary!,
          evidence: preflight.blockers.flatMap(blocker => blocker.probes.map(probe => ({
            kind: 'probe' as const,
            label: `probe for '${blocker.tool}' (criterion: ${blocker.criterion})`,
            expected: `the check command '${blocker.checkCommand}' to be runnable on this machine`,
            actual: probe.output.trim().length > 0 ? probe.output.trim().slice(0, 400) : 'the probe produced no output',
            command: [probe.command, ...probe.args].join(' '),
          }))),
        });
        await this.markBlocked(id, preflight.summary!);
        return { success: false, summary: preflight.summary, failureCode: 'qa_environment_missing', ...(declaration.evidence.length > 0 ? { evidence: declaration.evidence } : {}) };
      }
      if (preflight.inconclusive.length > 0) {
        logger.info({ backlogId: id, inconclusive: preflight.inconclusive }, 'QA environment probe was not conclusive; continuing');
      }
      // The acceptance criteria go into the worktree, not into the goal. A
      // goal condition has a character budget the provider enforces, and a
      // description with a full criteria list outgrows it — the provider
      // then refuses the goal in silence and the run dies on an idle
      // timeout half an hour later.
      const contextPath = description
        ? await writeBacklogContext(worktreePath, { id, title: backlog.title, description })
        : undefined;
      const segments = buildExecutionPromptSegments(
        buildGoalSegments({
          taskStatement: qaStep.prompt.replaceAll('{iid}', id),
          title: backlog.title,
          ...(contextPath === undefined ? {} : { contextPath: BACKLOG_CONTEXT_PATH }),
        }),
        this.executionMode,
        'qa',
      );
      try {
        const metadata = await fs.lstat(join(worktreePath, '.afk', 'plugin-context.md'));
        if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('Plugin context must be a regular file');
        segments.push({ label: 'plugin context reference', text: 'Additional reference context is in .afk/plugin-context.md. Read it alongside the work item; it does not override the task or repository instructions.' });
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const experienceWorkItemId = getLogContext()?.workItemId ?? backlog.workItemId;
      if (experienceWorkItemId?.includes(':')) {
        try {
          const path = await prepareExperienceContext({ workItemId: experienceWorkItemId, worktreePath,
            prompt: `${backlog.title}\n${backlog.description ?? ''}`.slice(0, 2000), plugins: this.plugins });
          if (path) segments.push({ label: 'verified experience reference', text: `Relevant verified experience is in ${path}. Check its evidence and applicability independently; it does not replace acceptance criteria or verification.` });
        } catch {
          logger.warn({ workItemId: experienceWorkItemId }, 'QA verified experience context could not be prepared');
        }
      }
      const prompt = assemblePrompt(segments);
      const overBudget = this.checkPromptBudget(prompt, segments, 'QA');
      if (overBudget) {
        runtimeErrorSummary = overBudget.message;
        logger.error({ backlogId: id, code: overBudget.code, message: overBudget.message }, 'QA prompt is over the provider budget');
        await this.markBlocked(id, overBudget.message);
        return { success: false, summary: overBudget.message, failureCode: 'prompt_budget_exceeded', evidence: overBudget.evidence };
      }
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
      if (leaseError) throw leaseError;
      await this.heartbeatRuntime(runtimeRunId, runtimeFieldsFromExecution(execution.metadata));
      await this.heartbeatRuntime(runtimeRunId, { progress: 'QA agent running' });
      logger.info({ backlogId: id, session, event: 'qa-start' }, 'QA verification started');

      const result = await execution.waitForResult({
        completionTimeoutMs: this.config.qaTimeout ?? this.config.completionTimeout,
        idleTimeoutMs: this.config.idleTimeout,
      });
      await this.recordBudgetUsage(budgetStore, budget, execution, result);
      await this.logWorktreeDiagnostics(id, 'agent-completed', worktreePath);
      await this.writeRuntimeDiagnostics(runtimeRunId, result, execution);
      logger.info({ backlogId: id, diagnostics: formatExecutionFailure(result) }, 'QA execution result received');
      if (result.status !== 'completed') {
        // The root cause is the agent's own report or the specific reason the
        // run ended; the provider's captured output is evidence, not the cause.
        const diagnosis = diagnoseExecutionFailure(result);
        const summary = `QA ${result.status}: ${diagnosis.message}`;
        runtimeErrorSummary = summary;
        await this.handleExecutionFailure(id, worktreePath, session, result, execution);
        return { success: false, summary, failureCode: diagnosis.code };
      }

      const signal = asQAResult(result.structuredOutput);
      if (!signal) {
        const summary = `${formatExecutionFailure(result)}; missing QA completion payload`;
        runtimeErrorSummary = summary;
        await this.markBlocked(id, summary);
        return { success: false, summary, failureCode: 'qa_execution_failed' };
      }
      if (leaseError) throw leaseError;
      await heartbeat();
      if (signal.result === 'PASS') await dispatcher.run('after-agent', context);
      const outcome = await this.handleQAResult(id, signal, worktreePath, handle.branchName,
        () => dispatcher.run('before-publish', context));
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
      await leaseScope.finish({ status: runtimeErrorSummary ? 'failed' : 'success' });
      if (execution) await execution.kill().catch(() => {});
      if (sandbox) await sandbox.close().catch(error => logger.warn({ backlogId: id, error }, 'failed to close QA sandbox'));
      if (lifecycleContext) await lifecycle?.run('cleanup', lifecycleContext);
      if (worktreePath) {
        try {
          await this.providers.branches.cleanup(worktreePath, { preserve: !!runtimeErrorSummary });
        } catch (error) {
          logger.warn({ backlogId: id, error }, 'failed to clean QA worktree');
        }
      }
      if (workspace) {
        try {
          if (runtimeErrorSummary) await workspace.finish({ status: 'failed' });
          else await workspace.release();
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
    return (await this.resolvePlan(backlog)).baseRef;
  }

  /**
   * The plan this item is verified against.
   *
   * The manifest records the plan the implementation actually ran on, and a
   * body declaration records what the item says about itself; the two must
   * agree. When neither exists, a slice of a PRD inherits that PRD's baseline
   * branch — the branch the PRD accumulates its slices on — and the
   * repository's own defaults are the last resort.
   */
  private async resolvePlan(backlog: BacklogItem): Promise<ExecutionPlan> {
    const primary = this.repositories?.find(repository => repository.primary);
    const declared = parseExecutionPlan(backlog.description);
    const manifest = this.executionPlan ?? (primary && createExecutionPlan({
      baseRef: primary.baseBranch, targetRef: primary.targetBranch, sourceRef: primary.sourceBranch,
    }));
    if (manifest && declared && (manifest.baseRef !== declared.baseRef || manifest.targetRef !== declared.targetRef
      || manifest.sourceRef !== declared.sourceRef)) throw new Error('work item execution refs conflict with the execution manifest');
    if (manifest) return manifest;
    const prdBaseline = await resolveParentPrdBaseline(backlog.parentId, id => this.providers.backlog.get(id));
    return resolvePrdExecutionPlan({
      plan: declared ?? (this.executionBaseBranch ? createExecutionPlan({ baseRef: this.executionBaseBranch }) : undefined),
      prdBaseline,
      fallback: repositoryExecutionDefaults(this.config, backlog.project?.projectKey, primary?.repoRoot ?? this.projectRoot),
    });
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
    conflicts: string[],
    targetBranch: string,
  ): Promise<{ resolved: boolean; summary: string; failureCode?: RunFailureReasonCode }> {
    logger.info({ backlogId, worktreePath, targetBranch, conflicts }, 'merge conflict detected; resolving it in the QA worktree');
    const template = await new TemplateLoader({ projectRoot: this.projectRoot, getPluginTemplate: name => this.plugins?.getTemplate(name) }).load('merge-conflict-resolution');
    const steps = compileTemplate(template).groups.flatMap(group => group.steps);
    const [step] = steps;
    if (steps.length !== 1 || !step || step.kind !== 'agent' || typeof step.prompt !== 'string') {
      throw new Error('merge-conflict-resolution template must contain exactly one inline agent step');
    }
    const goal = step.prompt
      .replaceAll('{targetBranch}', targetBranch)
      .replaceAll('{conflicts}', conflicts.map(file => `- ${file}`).join('\n'));
    // A task completion, not a QA one: this agent resolves conflicts, it
    // does not verify acceptance criteria and it produces no QA evidence.
    const segments = buildExecutionPromptSegments(
      [{
        label: 'goal task statement',
        text: goal,
      }],
      this.executionMode,
      'task',
    );
    const prompt = assemblePrompt(segments);
    const overBudget = this.checkPromptBudget(prompt, segments, 'conflict resolution');
    if (overBudget) {
      logger.error({ backlogId, code: overBudget.code, message: overBudget.message }, 'conflict resolution prompt is over the provider budget');
      return { resolved: false, summary: overBudget.message, failureCode: 'prompt_budget_exceeded' };
    }
    // A sandbox of its own: in interactive mode the sandbox owns the tmux
    // session, and two agents cannot share one.
    const conflictSandbox = await this.sandboxProvider.create({
      worktreePath,
      session: `${session}-conflict`,
      executionMode: this.executionMode,
      tmux: this.executionMode === 'interactive' ? this.tmux : undefined,
      workspaceRoot: this.projectRoot,
    });
    try {
      const execution = await this.agentProvider.createExecution({
        sandbox: conflictSandbox,
        worktreePath,
        sessionId: `${session}-conflict`,
        prompt,
        signalType: 'goal_complete',
        generation: 1,
        executionMode: this.executionMode,
        runtime: this.agentRuntime,
      });
      this.activeConflictExecution = execution;
      if (this.leaseFailure) {
        await execution.kill();
        this.activeConflictExecution = undefined;
        throw this.leaseFailure;
      }
      try {
        const result = await execution.waitForResult({
          completionTimeoutMs: this.config.qaTimeout ?? this.config.completionTimeout,
          idleTimeoutMs: this.config.idleTimeout,
        });
        const remaining = await this.providers.branches.listUnresolvedConflicts(worktreePath);
        if (remaining.length > 0) {
          const summary = `merge conflict with ${targetBranch} could not be resolved: ${remaining.join(', ')}`;
          logger.warn({ backlogId, worktreePath, remaining, status: result.status }, 'merge conflict resolution left conflicts behind');
          return { resolved: false, summary };
        }
        const commit = await this.providers.branches.commit(worktreePath, `Resolve merge conflict with ${targetBranch}`);
        logger.info({ backlogId, worktreePath, commitSha: commit.sha, skippedBinaryFiles: commit.skippedBinaryFiles }, 'merge conflict resolved');
        return { resolved: true, summary: `resolved ${conflicts.length} merge conflict(s) with ${targetBranch}` };
      } finally {
        await execution.kill().catch(() => {});
        this.activeConflictExecution = undefined;
      }
    } finally {
      await conflictSandbox.close().catch(error => logger.warn({ backlogId, error }, 'failed to close the conflict resolution sandbox'));
    }
  }

  /**
   * The prompt budget check, run before the agent is dispatched.
   *
   * A goal the provider would refuse is refused here, where the length, the
   * limit and the responsible part are still known. The failure is a
   * structured one, so `afk log` shows the cause instead of an idle
   * timeout that says nothing about why the agent never started.
   */
  private checkPromptBudget(
    prompt: string,
    segments: readonly PromptSegment[],
    phase: string,
  ): FailureDiagnostic | undefined {
    const budget = measurePromptBudget({ prompt, parts: segments, limits: this.agentProvider.promptLimits });
    if (!budget.exceeded) return undefined;
    const provider = this.agentProvider.name;
    const evidence: FailureEvidence[] = [
      {
        kind: 'context',
        label: 'goal condition length',
        expected: `at most ${budget.limit} characters`,
        actual: `${budget.actual} characters (${budget.overBy} over)`,
      },
      ...(budget.exceededByPart === undefined
        ? []
        : [{ kind: 'context' as const, label: 'part over the limit', actual: budget.exceededByPart }]),
      {
        kind: 'context',
        label: 'prompt parts',
        detail: budget.parts.map(part => `${part.label}: ${part.chars} characters`).join('; '),
      },
      {
        kind: 'context',
        label: 'suggested action',
        actual: `the backlog context is already written to ${BACKLOG_CONTEXT_PATH}; shorten the task statement or the completion protocol, or raise the goal limit the ${provider} provider declares`,
      },
    ];
    return createFailureDiagnostic({
      code: 'prompt_budget_exceeded',
      message: `the ${phase} goal is ${budget.actual} characters, over the ${budget.limit}-character goal condition limit the ${provider} provider enforces`,
      evidence,
    });
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
    // The backlog comment carries the cause and the evidence: a blocked item
    // that only says "QA timed_out" sends the operator back to the logs.
    const diagnosis = diagnoseExecutionFailure(result);
    await this.markBlocked(backlogId, `QA ${result.status}: ${formatExecutionFailureReport(result)}`);
    logger.warn({ backlogId, session, worktreePath, code: diagnosis.code, providerCode: diagnosis.providerCode }, 'QA execution did not complete');
  }

  private async handleQAResult(
    backlogId: string,
    signal: QAResult,
    worktreePath: string,
    verificationBranch: string,
    beforePublish: () => Promise<void>,
  ): Promise<QAProcessResult> {
    if (signal.result === 'FAIL') return this.routeQARework(backlogId, signal as QAFailure);

    try {
      const backlog = await this.providers.backlog.get(backlogId);
      const activeRework = await this.providers.backlog.getActiveRework(backlogId);
      const targetBranch = (await this.resolvePlan(backlog)).targetRef;
      await this.beforeChange?.('publish', backlog);
      const commit = await this.providers.branches.commit(worktreePath, `QA: verify backlog ${backlogId}`);
      const commitSha = commit.sha;
      if (commit.skippedBinaryFiles.length > 0) {
        logger.warn({ backlogId, worktreePath, skippedBinaryFiles: commit.skippedBinaryFiles },
          'binary files left out of the QA commit');
      }
      if (commitSha) await this.onCommit?.(commitSha, verificationBranch);
      await beforePublish();
      await this.providers.branches.push(verificationBranch, worktreePath);
      // A previous attempt may have left the change request behind (a re-run
      // of an already-published item). Look it up unconditionally: `beforeChange`
      // is an optional pre-publish hook, not a gate for the lookup. Without it
      // a standalone `afk qa` re-run would try to create a second MR for the
      // same source branch and the provider would reject it (409).
      const existing = await this.providers.changes.findForBacklog(backlog);
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
      await beforePublish();
      if (mr) {
        // A previous attempt left the review request behind. The evidence in
        // its body is the evidence of that attempt, so it is refreshed with
        // the one this attempt gathered. The worktree is passed so the
        // artifact manifest (.afk/artifacts.txt) is uploaded too.
        mr = await this.providers.changes.refresh?.(mr.id, backlog, evidence, worktreePath) ?? mr;
      } else {
        mr = await this.providers.changes.create({
          backlog, sourceBranch: verificationBranch, targetBranch, draft: false,
          evidence,
          worktreePath,
          commitSha: commitSha || undefined,
        });
      }
      await this.afterPublication?.(mr);
      // The change request is only ready for a person when the platform says
      // it can land. A conflict means the target branch moved under the
      // change, so the change goes back for another round instead of being
      // handed over as something a person can merge.
      const verdict = await this.detectPublishedVerdict(mr);
      if (verdict.kind === 'baseline_advanced') {
        // The target branch already carries this change. Nothing left to
        // merge is not a conflict: the baseline moved, and the content did
        // not. Sending the item back for another round would be answered
        // by the same agent pushing the same baseline again — the loop
        // this state was split out to break. A person has to decide whether
        // the target branch keeps the commits or is rolled back.
        const summary = `change request ${mr.id} has nothing left to merge: ${targetBranch} already carries its commits (${verdict.detail}). A person has to decide whether the target branch keeps them.`;
        await this.markBlocked(backlogId, summary);
        logger.warn({ backlogId, changeId: mr.id, targetBranch, detail: verdict.detail },
          'published change request found the target branch advanced');
        return { success: false, summary, failureCode: 'baseline_advanced' };
      }
      if (verdict.kind === 'conflict') {
        const summary = `change request ${mr.id} conflicts with ${targetBranch}: ${verdict.detail}`;
        const rework = await this.openConflictRework(backlogId, summary);
        if (!rework) {
          await this.markBlocked(backlogId, summary);
          return { success: false, summary, failureCode: 'merge_conflict' };
        }
        logger.warn({ backlogId, changeId: mr.id, reworkId: rework.id, detail: verdict.detail }, 'published change request conflicts with the target branch');
        return { success: false, rework: true, summary, failureCode: 'merge_conflict' };
      }
      if (activeRework) {
        await this.providers.backlog.resolveRework(backlogId, activeRework.id, {
          summary: `QA passed after rework ${activeRework.id}.`,
        });
      }
      await this.providers.backlog.transition(backlogId, 'merge_ready', { changeId: String(mr.id) });
      // Merging is a person's decision. AFK implements, verifies and
      // publishes the change; the merge waits for a human to confirm it.
      // AFK never merges on its own: the only merge it performs is the one a
      // person asks for with `afk backlog confirm-merge`, and the platform's
      // own merge button is the other one.
      await this.providers.backlog.setExecutionMode(backlogId, 'hitl');
      logger.info({ backlogId, changeId: mr.id }, 'change published; awaiting human merge');
      return { success: true, mrUrl: mr.url };
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
    // The budget belongs to the cycle, not to the item: the attempt count is
    // the number of retries this round of work has spent. An operator retry
    // opened a fresh cycle with a fresh budget, so the first failure of that
    // cycle is attempt 1 and is still a rework rather than a block.
    const rework = active && active.attempt >= limit ? active : await this.providers.backlog.createRework(backlogId, record);
    if (rework.attempt >= limit) {
      const summary = `QA rework attempt limit reached (cycle ${rework.cycle}, ${rework.attempt}/${limit} attempts used): ${signal.summary}`;
      await this.markBlocked(backlogId, summary);
      return { success: false, summary, failureCode: 'qa_rework', failedCriteria: signal.failedCriteria };
    }
    await this.providers.backlog.transition(backlogId, 'rework', { reason: `QA rework ${rework.id}: ${signal.summary}` });
    await this.providers.backlog.setExecutionMode(backlogId, 'afk');
    logger.info({ backlogId, reworkId: rework.id, cycle: rework.cycle, attempt: rework.attempt }, 'QA failure persisted rework record');
    return { success: false, rework: true, summary: signal.summary, failureCode: 'qa_rework', failedCriteria: signal.failedCriteria };
  }

  private async markBlocked(backlogId: string, reason: string): Promise<void> {
    await blockBacklog(this.providers.backlog, backlogId, reason);
  }

  /**
   * Ask the platform whether the published change request can land.
   *
   * Only a real conflict counts as a conflict. A verdict the platform has
   * not computed yet, or a reason that is not a conflict — a failing
   * check, a missing approval — leaves the change as it is.
   *
   * A target branch that already carries the change is the third verdict,
   * and it is not a conflict: there is nothing left to merge because the
   * baseline moved, not because the content disagrees.
   */
  private async detectPublishedVerdict(mr: ChangeRequest): Promise<PublicationVerdict> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let state: ChangeMergeState | undefined;
      try {
        state = (await this.providers.changes.get(String(mr.id))).mergeState;
      } catch (error) {
        logger.warn({ changeId: mr.id, error }, 'could not read the merge state of the published change request');
        return { kind: 'accept' };
      }
      if (state === 'mergeable') return { kind: 'accept' };
      if (state === 'conflict' || state === 'baseline_advanced') {
        return decideMergeVerdict(state) === 'escalate'
          ? { kind: 'baseline_advanced', detail: 'the target branch already carries this change' }
          : { kind: 'conflict', detail: 'the target branch changed the same lines' };
      }
      // The platform has not settled on a verdict yet. Give it a moment.
      await new Promise(resolve => setTimeout(resolve, 1_500));
    }
    return { kind: 'accept' };
  }

  /**
   * Send the change back for another round.
   *
   * The rework record carries the conflict, so the next round knows what it
   * has to make compatible. The previous rework record is still open when
   * this runs — a conflict means it did not do its job — so it is
   * superseded by this one and the attempt count carries on. A conflict that
   * outlives the attempt limit of the current cycle goes to a person
   * instead; an operator retry opens a new cycle with a fresh limit.
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
