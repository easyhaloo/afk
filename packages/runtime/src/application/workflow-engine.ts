import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'node:crypto';
import { simpleGit } from 'simple-git';
import { WorktreeManager } from '../infrastructure/git/index.js';
import { TmuxClient, createTmuxClient } from '../infrastructure/tmux/index.js';
import { createSandboxProvider } from '../infrastructure/sandbox/index.js';
import { createAgentProvider } from '../domain/agents/index.js';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderName,
  AgentExecution,
  ExecutionResult,
} from '../infrastructure/sandbox/types.js';
import type { AgentProvider, AgentProviderName, AgentRuntimeSelection, SessionSnapshot, ExecutionMode } from '../domain/agents/types.js';
import { getTokenUsage, configureStatusline, logger, resolveLogDir, resolveTimeoutSnapshotDir, withLogContext } from '../infrastructure/io/index.js';
import { getWorkflowConfig } from '../infrastructure/config/manager.js';
import { loadModules, parseModuleParams } from './runners/registry.js';
import type { ModuleParams } from './runners/registry.js';
import { LifecycleDispatcher, type LifecycleModule, type LifecycleContext } from './workflows/lifecycle.js';
import { Watchdog, createWatchdog } from './workflows/watchdog.js';
import type { WorkflowConfig } from '../infrastructure/config/manager.js';
import { HandoffCoordinator, handoffDocPath } from './workflows/handoff.js';
import { attemptNativeResume } from './workflows/resume.js';
import { BudgetManager } from './workflows/budget.js';
import { BudgetStore } from './workflows/budget-store.js';
import type { InitContext } from './workflows/lifecycle.js';
import { defaultSessionStoreChain } from './sessions/chain.js';
import { TemplateLoader } from '../domain/templates/loader.js';
import { PlanExecutor } from './workflows/plan-executor.js';
import { SystemActionExecutor } from './workflows/system-actions.js';
import { RunResourceScope, type RunOutcomeStatus } from './workflows/resource-scope.js';
import {
  assemblePrompt,
  buildExecutionPromptSegments,
  isAcVerificationPass,
  parseAcVerificationFailure,
  type AcVerificationFailure,
  type CompletionKind,
  type PromptSegment,
} from './workflows/execution-protocol.js';
import { BACKLOG_CONTEXT_PATH, buildGoalSegments, writeBacklogContext } from './workflows/backlog-context.js';
import { describePublishBoundary } from '../domain/branches/publish-boundary.js';
import { measurePromptBudget } from '../domain/agents/prompt-budget.js';
import { shouldReusePrimaryWorktree } from './workflows/worktree-selection.js';
import type { PluginRuntime } from './plugins/runtime.js';
import type { Step, StepResult } from '../domain/templates/types.js';
import type { BranchHandle, BranchStrategyConfig } from '../domain/branches/types.js';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import type { BacklogClaim, BacklogItem, BacklogState } from '../domain/backlog/index.js';
import { resolveItemExecutionBase } from '../domain/backlog/creation.js';
import { blockBacklog } from '../domain/backlog/commands.js';
import { parseWorkItemId } from '../domain/work-item/identity.js';
import { TaskRuntimeManager } from './runtime/task-runtime.js';
import { validateObservationIdentity, type WorkflowRunRepository } from './workflows/run-request.js';
import {
  MultiRepositoryPreparer,
  type MultiRepositoryPreparationService,
  type PreparedRepositorySet,
} from './workflows/multi-repository-preparer.js';
import { runtimeFieldsFromExecution, runtimeFieldsFromSelection } from './runtime/agent-metadata.js';
import type { ObservationContext, RunEventData } from '@afk/core';
import type { RunObserver } from '../observability/run-observer.js';
import { collectAgentTelemetry } from '../infrastructure/observability/agent-telemetry.js';
import {
  appendFailure,
  createFailureDiagnostic,
  diagnoseExecutionFailure,
  diagnoseStepFailure,
  renderFailureReport,
  renderFailureSummary,
  snapshotFailure,
  type FailureDiagnostic,
} from './workflows/failure-diagnostic.js';

export class AuditPersistenceError extends Error {
  constructor(eventType: string, cause?: unknown) {
    super(`required audit event '${eventType}' could not be persisted: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'AuditPersistenceError';
  }
}

/**
 * The root cause of a failed agent execution.
 *
 * The agent's own report is the cause when there is one. The provider's
 * captured output is evidence and never the cause: mixing the two is how a
 * pre-commit hook's rejection got replaced by the tail of a `pnpm` log.
 */
export function formatExecutionFailure(result: ExecutionResult): string {
  return diagnoseExecutionFailure(result).message;
}

/**
 * The root cause of a failed agent execution, with the evidence behind it.
 *
 * For a report a person reads: the cause on the first line, the provider
 * output and the structured payload below it.
 */
export function formatExecutionFailureReport(result: ExecutionResult): string {
  return renderFailureReport([diagnoseExecutionFailure(result)]);
}

function formatCriteria(criteria: Array<{ id: string; expected: string; actual: string }>): string {
  return criteria.map(criterion => `- ${criterion.id}: expected ${criterion.expected}; actual ${criterion.actual}`).join('\n');
}

function formatAcCorrection(failure: AcVerificationFailure): string {
  return `\n\nAC correction required. Work on the current branch and repair exactly these failed acceptance criteria before the verifier runs again:\n${formatCriteria(failure.failedCriteria)}\nVerifier summary: ${failure.summary}`;
}

function formatReworkContext(rework: import('../domain/backlog/index.js').ReworkRecord): string {
  const round = `cycle ${rework.cycle}, attempt ${rework.attempt}`;
  if (rework.source === 'conflict') {
    // The change request could not be merged because the target branch
    // changed the same lines. Making the change compatible with the target
    // here is what keeps the next merge conflict-free.
    return `\n\nAn open merge-conflict rework record (${rework.id}, ${round}) applies to this backlog. The change request could not be merged because the target branch changed the same lines. Make the change compatible with the target branch — merge the target branch into the current branch and resolve the conflicts, keeping the intent of both sides:${rework.summary}`;
  }
  return `\n\nAn open QA rework record (${rework.id}, ${round}) applies to this backlog. Repair it on the current branch and run its required checks:\n${formatCriteria(rework.failedCriteria)}\nQA summary: ${rework.summary}${rework.requiredChecks.length ? `\nRequired checks:\n${rework.requiredChecks.map(check => `- ${check.command}: ${check.expected}`).join('\n')}` : ''}`;
}

/**
 * The issue number of a backlog reference.
 *
 * The reference is either a provider-local issue number or a canonical global
 * identity; both name the same issue number.
 */
function issueNumberOf(reference: string): number {
  if (/^[1-9]\d*$/.test(reference)) return Number(reference);
  try {
    return parseWorkItemId(reference).issueNumber;
  } catch {
    return 0;
  }
}

export interface RunnerOptions {
  /** Canonical backlog ID. */
  backlogId: string;
  /**
   * The canonical global identity of the work item being executed.
   *
   * It is the identity the run, its events and its runtime record carry. It
   * is never derived from the provider-local backlog id, because the same
   * issue number in two repositories is two different work items.
   */
  workItemId?: string;
  observationRunId?: string;
  observationWorkItemId?: string;
  auditRequired?: boolean;
  /** Local-only numeric worktree key for older git helpers. */
  iid?: number;
  session: string;
  targetBranch: string;
  baseBranch?: string;
  baseBranchExplicit?: boolean;
  maxRetries?: number;
  hardTimeoutMs?: number;
  completionTimeoutMs?: number;
  /** How long the agent may stay silent before the run gives up on it. */
  idleTimeoutMs?: number;
  /** Max automatic context-handoff rounds before falling back to terminal handoff. */
  maxHandoffs?: number;
  /** Absolute token threshold that triggers context handoff (runner polls statusline). */
  contextHighTokens?: number;
  /** Max total tokens across all handoff generations before a terminal handoff. */
  maxTotalTokens?: number;
  /** Target project (cross-project dispatch). Drives ProjectResolverModule. */
  projectName?: string;
  /** Explicit repository root. Cross-project runs never mutate process.cwd(). */
  repoRoot?: string;
  /** Execution workspace containing every manifest checkout. Defaults to repoRoot. */
  workspaceRoot?: string;
  /** Repositories participating in this run; the primary remains projected onto legacy fields. */
  repositories?: WorkflowRunRepository[];
  /** Module names to activate (e.g., ['isolate', 'mock-server']) */
  ext?: string[];
  /** Module parameters (e.g., ['isolate.auto=true']) */
  extParams?: string[];
  /** Sandbox provider name (default: 'local'). */
  sandboxProvider?: SandboxProviderName;
  /** Agent provider name (default: 'claude-code'). */
  agentProvider?: AgentProviderName;
  /** Provider-resolved branch strategy metadata. */
  branchStrategy?: BranchStrategyConfig;
  /** Workflow template name to run instead of the default two-phase flow. */
  template?: string;
  /** Execution mode: 'interactive' (tmux + signal file) or 'batch' (stream-json). Default: 'interactive'. */
  executionMode?: ExecutionMode;
  /** Lease heartbeat cadence for providers using a durable claim. */
  claimHeartbeatIntervalMs?: number;
}

export type WorkflowRunResult =
  | { success: true; url?: string }
  | { success: false; url?: string; skipped?: 'not_claimed' };

/**
 * Optional collaborator overrides for WorkflowRunner. Tests inject a fake
 * coordinator (and tmux) to exercise the phase loop's routing without a real
 * tmux / provider / filesystem - the same factory pattern LoopRunner uses for
 * WorkflowRunner itself.
 */
export interface RunnerDependencies {
  coordinatorFactory?: (deps: {
    backlog: import('../domain/backlog/index.js').BacklogProvider;
    tmux: TmuxClient;
    watchdog: Watchdog;
    config: WorkflowConfig;
  }) => HandoffCoordinator;
  /** Override the tmux client (tests). Defaults to a new TmuxClient. */
  tmux?: TmuxClient;
  /** Override the watchdog (tests). Defaults to a new Watchdog. */
  watchdog?: Watchdog;
  /** Sandbox provider (tests / future). Defaults to LocalSandboxProvider. */
  sandboxProvider?: SandboxProvider;
  /** Agent provider (tests). Defaults to ClaudeCodeProvider. */
  agentProvider?: AgentProvider;
  /** Immutable runtime selection resolved by the caller. */
  agentRuntime?: AgentRuntimeSelection;
  /** Session store chain (tests / future). Defaults to defaultSessionStoreChain. */
  sessionStoreChain?: (worktreePath: string) => import('./sessions/types.js').SessionStoreChain;
  /** Workflow config: all timeout and budget values. Defaults to getWorkflowConfig(). */
  config?: WorkflowConfig;
  /** Typed plugin capabilities available to this run. */
  plugins?: PluginRuntime;
  /** Canonical backlog/branch/change providers. */
  providers?: ProviderBundle;
  /** Local runtime projection for the read-only Tasks monitor. */
  runtimeManager?: TaskRuntimeManager;
  /** Append-only audit observer, composed and injected by the caller. */
  observer: RunObserver;
  /** Prepares all repositories declared by an execution manifest. */
  multiRepositoryPreparer?: MultiRepositoryPreparationService;
}

/**
 * Signal-driven workflow runner.
 *
 * Two-phase design:
 *   Phase 1 (Implement): run implement step -> wait goal_complete
 *   Phase 2 (Verify):   run verify step -> wait goal_complete with QA payload
 *   autoWrapup:         push implementation branch, transition verification, cleanup worktree
 *
 * Each phase is a loop: send goal -> poll for the completion signal OR the
 * context threshold (statusline token usage). On context_high the session is
 * interrupted, the agent's summary is captured to a doc + issue comment, and
 * the session is relaunched with the summary injected - until the phase
 * completes or the handoff budget runs out.
 *
 * Context detection is done by the RUNNER, not the agent: the agent cannot
 * reliably sense its own context limit (Claude Code's TUI warnings are
 * rendering-layer only, and the compaction system message arrives too late),
 * so we poll `<worktree>/.afk/claude-status.json` token usage (written by the
 * statusline tee on every turn) against `contextHighTokens`.
 *
 * The handoff cluster (negotiate summary -> persist doc -> post comment ->
 * relaunch or terminate) lives behind the {@link HandoffCoordinator} seam;
 * the runner only decides WHEN to hand off (context_high, budget exhausted)
 * and routes the outcome. The hard-timeout {@link Watchdog} is a separate
 * module shared by both.
 */

interface StepRunCtx {
  iid: number;
  session: string;
  baseSession: string;
  primaryWtPath: string;
  primaryBranch: string;
  baseBranch: string;
  hardTimeoutMs: number;
  completionTimeoutMs: number;
  /** How long the agent may stay silent before the run gives up on it. */
  idleTimeoutMs: number;
  contextHighTokens: number;
  budget: BudgetManager;
  persistBudget: () => Promise<void>;
  stepIndex: number;
  executionMode?: ExecutionMode;
}

interface PhaseResult {
  completed: boolean;
  output?: unknown;
}

export class WorkflowRunner {
  private readonly worktree = new WorktreeManager();
  private tmux: TmuxClient;
  private watchdog: Watchdog;
  private coordinator: HandoffCoordinator;
  private sandboxProvider: SandboxProvider;
  private agentProvider: AgentProvider;
  private readonly agentRuntime?: AgentRuntimeSelection;
  /** Session store chain factory — defaults to defaultSessionStoreChain. */
  private sessionStoreChainFactory: (worktreePath: string) => import('./sessions/types.js').SessionStoreChain;
  /** Resolved sandbox provider name (set in run()). */
  private sandboxProviderName: SandboxProviderName = 'local';
  /** Resolved agent provider name (set in run()). */
  private agentProviderName: AgentProviderName = 'claude-code';
  /** Execution mode (set in run()). */
  private executionMode: ExecutionMode = 'interactive';
  private sandbox: Sandbox | undefined;
  /** Where workflow timeout snapshots are written (`<log root>/timeout`). */
  private timeoutSnapshotDir: string;
  private modules: LifecycleModule[] = [];
  private lifecycleDispatcher?: LifecycleDispatcher;
  private extParams: ModuleParams = {};
  private originalCwd: string = '';
  private repoRoot: string = '';
  private workspaceRoot: string = '';
  private lifecycleCtx: LifecycleContext = { iid: 0, worktreePath: '', baseBranch: '', sessionName: '', params: {} };
  /** Branch handles created per step in template execution. Cleaned up in teardownSession. */
  private stepBranchHandles: BranchHandle[] = [];
  private stepSandboxes: Sandbox[] = [];
  private config: WorkflowConfig;
  private systemActionsRan = false;
  private readonly agentProviderInjected: boolean;
  private readonly sandboxProviderInjected: boolean;
  private primaryHandle?: BranchHandle;
  private resourceScope?: RunResourceScope;
  private readonly plugins?: PluginRuntime;
  private readonly providers: ProviderBundle;
  private activeBacklog?: BacklogItem;
  private activeClaim?: BacklogClaim;
  private leaseLost = false;
  private readonly runtimeManager: TaskRuntimeManager;
  private runtimeRunId?: string;
  /**
   * The failures of this run, oldest first.
   *
   * The first entry is the root cause and is never replaced. Every later
   * failure is appended to the chain, so secondary information cannot
   * destroy the reason the run actually failed.
   */
  private failureChain: FailureDiagnostic[] = [];
  private acFeedback?: AcVerificationFailure;
  private activeRework?: import('../domain/backlog/index.js').ReworkRecord;
  private readonly observer: RunObserver;
  private observationContext?: ObservationContext;
  private readonly multiRepositoryPreparer: MultiRepositoryPreparationService;
  private preparedRepositories?: PreparedRepositorySet;
  private stopRepositoryHeartbeat?: () => void;
  private preparedRepositoryFinish?: Promise<void>;
  private readonly implementationBaseShas = new Map<string, string>();
  private readonly implementationCommitShas = new Map<string, string>();

  /**
   * Inject a sandbox for testing. Production code goes through runBody →
   * sandboxProvider.create(). This seam exists so tests can wire a fake
   * sandbox that emits controlled ExecutionResult values without driving the
   * real LocalSandboxProvider path (which creates tmux + worktree, neither
   * of which exist in unit tests).
   */
  setSandbox(sandbox: Sandbox): void {
    this.sandbox = sandbox;
  }

  /**
   * Build a session store chain for the given worktree. The chain is created
   * lazily per-worktree because the FileSessionStore / HandoffSessionStore
   * pin the worktree directory at construction time.
   *
   * Tests / future hot-path wiring use this to consult native snapshots
   * before falling back to the handoff Markdown. The phase loop in runPhase
   * does not yet call this — that's wired separately; the chain is exposed
   * here so the integration is testable in isolation.
   */
  sessionStoreChainFor(worktreePath: string): import('./sessions/types.js').SessionStoreChain {
    return this.sessionStoreChainFactory(worktreePath);
  }

  constructor(providers: ProviderBundle, deps: RunnerDependencies) {
    if (!deps?.observer) throw new Error('WorkflowRunner requires an observer');
    this.tmux = deps?.tmux ?? createTmuxClient();
    this.timeoutSnapshotDir = resolveTimeoutSnapshotDir();
    this.watchdog = deps?.watchdog ?? createWatchdog(resolveLogDir());
    this.config = deps?.config ?? getWorkflowConfig();
    this.plugins = deps?.plugins;
    this.providers = providers;
    this.coordinator = deps?.coordinatorFactory
      ? deps.coordinatorFactory({ backlog: providers?.backlog, tmux: this.tmux, watchdog: this.watchdog, config: this.config } as never)
      : ({ handoff: async () => 'terminal' } as unknown as HandoffCoordinator);
    this.sandboxProvider = deps?.sandboxProvider ?? createSandboxProvider('local', { worktreeManager: this.worktree });
    this.sandboxProviderInjected = deps?.sandboxProvider !== undefined;
    this.agentProviderInjected = deps?.agentProvider !== undefined;
    this.agentProvider = deps?.agentProvider ?? createAgentProvider(this.agentProviderName);
    this.agentRuntime = deps?.agentRuntime;
    // Default to the standard chain: FileSessionStore (native) -> HandoffSessionStore (Markdown fallback).
    this.sessionStoreChainFactory = deps?.sessionStoreChain ?? defaultSessionStoreChain;
    this.runtimeManager = deps?.runtimeManager ?? new TaskRuntimeManager();
    this.observer = deps.observer;
    this.multiRepositoryPreparer = deps?.multiRepositoryPreparer ?? new MultiRepositoryPreparer();
  }

  /**
   * Full workflow: worktree -> tmux session -> /goal -> wait -> cleanup.
   * Every explicit terminal path does its own cleanup; the catch below only
   * covers unexpected exceptions (crash path), and the finally only ever
   * disarms the watchdog.
   */
  async run(options: RunnerOptions): Promise<WorkflowRunResult> {
    validateObservationIdentity(options);
    const context = this.createObservationContext(options.backlogId, options.session, options);
    return withLogContext(context, () => this.runObserved(options, context));
  }

  private async runObserved(options: RunnerOptions, context: ObservationContext): Promise<WorkflowRunResult> {
    const {
      iid: requestedIid,
      session,
      targetBranch,
      hardTimeoutMs = this.config.workflowHardTimeout,
      completionTimeoutMs = this.config.completionTimeout,
      idleTimeoutMs = this.config.idleTimeout,
      maxHandoffs = Math.min(Math.ceil(this.config.goalBudget / 1_000_000), 20),
      contextHighTokens = this.config.contextThreshold,
      maxTotalTokens = this.config.goalBudget,
    } = options;
    let baseBranch = options.baseBranch ?? 'main';

    const backlogId = options.backlogId;
    const iid = requestedIid ?? issueNumberOf(backlogId);
    let terminalOutcome: RunOutcomeStatus = 'failed';
    this.resourceScope = undefined;
    this.activeBacklog = undefined;
    this.activeClaim = undefined;
    this.leaseLost = false;
    this.runtimeRunId = undefined;
    this.failureChain = [];
    this.preparedRepositories = undefined;
    this.stopRepositoryHeartbeat = undefined;
    this.preparedRepositoryFinish = undefined;
    this.implementationBaseShas.clear();
    this.implementationCommitShas.clear();
    this.observationContext = context;
    await this.recordObservation({
      kind: 'run.requested',
      run: {
        id: this.observationContext.runId,
        workItemId: this.observationContext.workItemId,
        profileId: this.observationContext.profileId,
        attempt: this.observationContext.attempt,
        status: 'pending',
      },
    });
    if (this.providers) {
      const backlog = await this.providers.backlog.get(backlogId);
      if (backlog.kind === 'prd') throw new Error(`backlog ${backlogId} is a PRD anchor and is not runnable`);
      if (!options.baseBranchExplicit) {
        baseBranch = await resolveItemExecutionBase(this.providers.backlog, backlog, baseBranch);
        options = { ...options, baseBranch,
          branchStrategy: options.branchStrategy?.type === 'named' ? { ...options.branchStrategy, baseBranch } : options.branchStrategy,
          repositories: options.repositories?.map(repository => repository.primary ? { ...repository, baseBranch } : repository) };
      }
      const claimed = await this.providers.backlog.claim(backlogId, session);
      if (!claimed) {
        logger.info({ backlogId }, 'backlog is not runnable or was claimed by another worker');
        await this.recordObservation({ kind: 'run.finished', outcome: 'cancelled', reason: 'not_claimed' });
        return { success: false, skipped: 'not_claimed' };
      }
      this.activeBacklog = claimed.item;
      this.activeClaim = claimed;
      try {
        this.activeRework = await this.providers.backlog.getActiveRework(backlogId);
        await this.recordObservation({ kind: 'run.started' });
        await this.recordObservation({ kind: 'lease.granted', leaseId: session });
      } catch (error) {
        await claimed.release();
        throw error;
      }
      // Establish the terminalizer immediately after claim acquisition, before
      // template validation or any branch/sandbox resource can be created.
      // Every terminal path shares this scope, so a native no-op lease and a
      // filesystem lease have identical release semantics.
      this.resourceScope = new RunResourceScope({
        repoRoot: options.repoRoot ?? process.cwd(),
        baseBranch,
        onCleanup: () => claimed.release(),
      });
      try {
        this.resourceScope.registerHeartbeat(
          claimed.heartbeat,
          options.claimHeartbeatIntervalMs ?? 10_000,
          async error => {
            this.leaseLost = true;
            await this.resourceScope?.stopExecutions().catch(stopError => logger.warn({ stopError }, 'failed to stop execution after lease loss'));
            try {
              await this.providers.backlog.transition(claimed.item.id, 'blocked', { reason: `claim heartbeat failed: ${(error as Error).message}` });
              await this.providers.backlog.setExecutionMode(claimed.item.id, 'hitl');
            } catch (routeError) {
              logger.warn({ backlogId: claimed.item.id, error: routeError }, 'failed to route heartbeat failure to hitl');
            }
          },
        );
      } catch (error) {
        await this.markBacklogBlocked(`claim heartbeat setup failed: ${(error as Error).message}`);
        await this.resourceScope.finish({ status: 'failed' });
        throw error;
      }
      const branchStrategy = options.branchStrategy ?? { type: 'named' as const, branch: claimed.item.branchName, baseBranch };
      options = { ...options, branchStrategy };
      if (branchStrategy.type === 'named' && branchStrategy.branch !== claimed.item.branchName) {
        this.activeBacklog = { ...claimed.item, branchName: branchStrategy.branch };
      }
    }

    const effectiveTemplate = options.template ?? 'issue-implementation';
    this.sandboxProviderName = options.sandboxProvider ?? 'local';
    this.agentProviderName = options.agentProvider ?? 'claude-code';
    this.executionMode = options.executionMode ?? 'batch';
    this.repoRoot = options.repoRoot ?? process.cwd();
    await this.startRuntime(options.backlogId, session);
    try {
    // Bind all git/worktree operations to the explicit project root. This
    // deliberately avoids process.chdir(), which is process-global state.
    this.systemActionsRan = false;
    this.primaryHandle = undefined;
    this.acFeedback = undefined;
    // Preserve injected WorktreeManager fakes and legacy cwd behavior when
    // no explicit project context was requested.

    // Resolve sandbox provider by name (CLI path).
    if (!this.sandboxProviderInjected) {
      this.sandboxProvider = this.sandboxProviderByName(this.sandboxProviderName);
    }

    // Resolve agent provider by name (CLI path). Agent registry must already have
    // the named provider registered (import side-effect or explicit registration).
    // Skip if constructor already injected one via deps (tests use this path).
    if (!this.agentProviderInjected) {
      this.agentProvider = createAgentProvider(this.agentProviderName);
    }

    // Load lifecycle modules
    this.modules = [...await loadModules(options.ext), ...(this.plugins?.getLifecycleModules() ?? [])];
    this.lifecycleDispatcher = new LifecycleDispatcher(this.modules);
    this.extParams = parseModuleParams(options.extParams);
    this.originalCwd = process.cwd();
    logger.info({ iid, session, modules: this.modules.map(m => m.name), extParams: this.extParams, sandbox: this.sandboxProviderName, agent: this.agentProviderName }, 'WorkflowRunner initialized');

    this.workspaceRoot = options.workspaceRoot ?? this.repoRoot;
    if (options.repositories?.length) {
      this.preparedRepositories = await this.multiRepositoryPreparer.prepare(options.repositories, this.workspaceRoot);
      if (this.preparedRepositories.heartbeat) this.stopRepositoryHeartbeat = this.resourceScope?.registerHeartbeat(this.preparedRepositories.heartbeat, 10_000, async error => {
        this.leaseLost = true;
        await this.resourceScope?.stopExecutions();
        await this.markBacklogBlocked(`repository lease lost: ${String(error)}`);
      });
      this.repoRoot = this.preparedRepositories.primary.repoRoot;
      this.resourceScope?.registerExternalResource({ finish: outcome => this.finishPreparedRepositories(outcome) });
    }

    // Validate template early so failures throw before worktree creation. A
    // claimed backlog must never be left in-progress when validation fails.
    await new TemplateLoader({ projectRoot: this.repoRoot }).load(effectiveTemplate);
    } catch (error) {
      if (error instanceof AuditPersistenceError) {
        await this.resourceScope?.finish({ status: 'failed' });
        throw error;
      }
      const setup = await this.classifyFailure(createFailureDiagnostic({
        code: 'workflow_setup',
        message: `workflow setup failed: ${(error as Error).message}`,
      }));
      await this.recordObservation({ kind: 'run.finished', outcome: 'failed', reason: setup.message, reasonCode: setup.code });
      await this.markBacklogBlocked(setup.message);
      await this.resourceScope?.finish({ status: 'failed' });
      await this.finishRuntime('blocked', setup.message);
      throw error;
    }

    try {
      let result = await this.runBody({
        iid, session, targetBranch, baseBranch, hardTimeoutMs, completionTimeoutMs, idleTimeoutMs, maxHandoffs,
        contextHighTokens, maxTotalTokens, projectName: options.projectName, repoRoot: this.repoRoot,
        workspaceRoot: this.workspaceRoot,
        branchStrategy: options.branchStrategy, template: effectiveTemplate, executionMode: this.executionMode,
      });
      if (result.success && this.leaseLost) {
        await this.markBacklogBlocked('claim heartbeat failed');
        terminalOutcome = 'failed';
        return { success: false };
      }
      if (result.success && this.preparedRepositories) {
        await this.resourceScope?.stopExecutions();
        await this.preparedRepositories.heartbeat?.();
        await this.activeClaim?.heartbeat();
        for (const repository of this.preparedRepositories.repositories) {
          await this.commitImplementationWork(iid, repository.handle.path);
          await this.recordImplementationCommit(repository.handle.path, repository.handle.branch);
        }
        try {
          await this.finishPreparedRepositories({ status: 'success' });
        } catch (error) {
          await this.classifyFailure(createFailureDiagnostic({
            code: 'repository_publication',
            message: `repository publication failed: ${(error as Error).message}`,
          }));
          result = { success: false };
        }
      }
      if (this.providers && this.activeBacklog) {
        if (result.success) {
          await this.providers.backlog.transition(this.activeBacklog.id, 'verification', undefined);
        } else {
          await blockBacklog(this.providers.backlog, this.activeBacklog.id, this.runtimeErrorSummary ?? 'workflow execution failed');
        }
      }
      terminalOutcome = result.success ? 'success' : 'failed';
      if (result.success) await this.recordObservation({ kind: 'implementation.completed' });
      else await this.recordObservation({
        kind: 'run.finished',
        outcome: result.success ? 'succeeded' : 'failed',
        reason: result.success ? 'implementation handed to QA' : this.runtimeErrorSummary ?? 'workflow execution failed',
        reasonCode: result.success ? undefined : this.failureChain[0]?.code,
      });
      return result;
    } catch (error) {
      if (error instanceof AuditPersistenceError) {
        await this.teardownSession(iid, session);
        throw error;
      }
      logger.error({ iid, err: error }, 'workflow runBody threw unexpectedly');
      // The crash is a consequence: whatever failed before it is still the
      // root cause, and the chain keeps both.
      const crash = await this.classifyFailure(createFailureDiagnostic({
        code: 'workflow_crash',
        message: `workflow crashed: ${(error as Error).message}`,
      }));
      const reason = this.runtimeErrorSummary ?? crash.message;
      await this.recordObservation({ kind: 'run.finished', outcome: 'failed', reason, reasonCode: this.failureChain[0]?.code });
      await this.cleanupOnFailure(iid, session, reason);
      await this.markBacklogBlocked(reason);
      throw error;
    } finally {
      let scopeError: unknown;
      try {
        await this.resourceScope?.finish({ status: terminalOutcome });
      } catch (err) {
        scopeError = err;
        if (terminalOutcome !== 'success') {
          scopeError = undefined;
          logger.warn({ iid, err }, 'resource scope cleanup failed on terminal failure');
        }
      }
      // Never leave an armed watchdog behind: it would fire later and write a
      // stale timeout signal into the retained worktree.
      this.watchdog.disarm();
      this.activeClaim = undefined;
      this.activeRework = undefined;
      await this.finishRuntime(
        terminalOutcome === 'success' ? 'completed' : 'blocked',
        terminalOutcome === 'success' ? 'implementation handed to QA' : 'implementation stopped',
      );
      if (scopeError !== undefined) {
        await this.markBacklogBlocked('resource cleanup failed');
        throw scopeError;
      }
    }
  }

  /** Resolve sandbox provider name to a SandboxProvider instance. */
  private sandboxProviderByName(name: SandboxProviderName): SandboxProvider {
    return createSandboxProvider(name, { worktreeManager: this.worktree });
  }

  /**
   * The root cause of this run, as one line.
   *
   * Derived from the failure chain, never stored on its own: the chain is the
   * only place a failure fact lives.
   */
  private get runtimeErrorSummary(): string | undefined {
    return renderFailureSummary(this.failureChain);
  }

  /**
   * Record a failure.
   *
   * The first failure recorded is the root cause and stays the root cause. A
   * later failure is appended to the chain and points back at the one before
   * it, so the reason a run failed is never overwritten by what happened
   * afterwards.
   */
  private recordFailure(failure: FailureDiagnostic): FailureDiagnostic {
    this.failureChain = appendFailure(this.failureChain, failure);
    return this.failureChain[this.failureChain.length - 1];
  }

  /**
   * Record a failure and publish it to the audit stream.
   *
   * The event carries the failure's own code and evidence, plus a snapshot of
   * the failure that came before it — the chain, so the first failure stays
   * readable in the stream.
   */
  private async classifyFailure(failure: FailureDiagnostic): Promise<FailureDiagnostic> {
    const recorded = this.recordFailure(failure);
    // The audit event is a side effect of the classification. A run that has
    // no observation context — a direct runBody call — still records the
    // fact; only the published event is skipped.
    if (!this.observationContext) return recorded;
    await this.recordObservation({
      kind: 'failure.classified',
      failureClass: recorded.class,
      summary: recorded.message,
      code: recorded.code,
      ...(recorded.cause ? { cause: snapshotFailure(recorded.cause) } : {}),
      evidence: recorded.evidence,
    });
    return recorded;
  }

  /**
   * Cleanup on unexpected crash: update GitHub issue first, then clean local
   * resources. This ensures issue status is updated even if the process
   * crashes afterward. Explicit failure paths (timeout / handoff / silent
   * stop) handle their own cleanup inside their handlers.
   */
  private async cleanupOnFailure(iid: number, session: string, reason = 'workflow crashed'): Promise<void> {
    try {
      await this.transitionBacklog(iid, 'blocked', reason);
    } catch (err) {
      logger.error({ iid, err }, 'failed to update GitHub on cleanup');
    }

    await this.teardownSession(iid, session);
    // Lifecycle cleanup hooks (zeroed context - may run before runBody
    // populates lifecycleCtx; modules must be idempotent).
    try {
      await this.runLifecycleHooks(
        ['after', 'cleanup'],
        { iid: 0, worktreePath: '', baseBranch: '', sessionName: '', params: this.extParams },
        true,
      );
    } catch (err) {
      logger.warn({ iid, err }, 'lifecycle cleanup failed after workflow crash');
    }
  }

  /**
   * Kill the tmux session, drop the control-mode connection, and mark the
   * worktree failed. Worktree itself is kept for inspection.
   */
  private async teardownSession(iid: number, session: string): Promise<void> {
    try { await this.resourceScope?.finish({ status: 'failed' }); } catch (err) {
      logger.warn({ iid, err }, 'resource scope cleanup failed');
    }
    this.stepBranchHandles = [];
    this.stepSandboxes = [];
  }

  // ── Template execution helpers ─────────────────────────────────────────────

  /**
   * The goal of a step, as segments.
   *
   * The backlog description is written into the worktree instead of into the
   * goal: a goal condition has a character budget the provider enforces, and
   * a description carrying the full acceptance criteria outgrows it. The
   * agent reads the file; the goal keeps the task, the title and a pointer.
   */
  private async resolveStepPrompt(step: Step, ctx: StepRunCtx | undefined, worktreePath: string): Promise<PromptSegment[]> {
    if (!step.prompt) throw new Error(`agent step '${step.id}' is missing prompt`);
    let taskStatement = typeof step.prompt === 'string' ? step.prompt : await fs.readFile(step.prompt.file, 'utf-8');
    // Variable substitution: {iid} → issue number
    if (ctx?.iid) {
      taskStatement = taskStatement.replaceAll('{iid}', String(ctx.iid));
    }
    const segments: PromptSegment[] = [];
    if (this.activeBacklog) {
      const description = this.activeBacklog.description?.trim();
      let contextPath: string | undefined;
      if (description) {
        await writeBacklogContext(worktreePath, {
          id: this.activeBacklog.id,
          title: this.activeBacklog.title,
          description,
        });
        contextPath = BACKLOG_CONTEXT_PATH;
      }
      segments.push(...buildGoalSegments({
        taskStatement,
        title: this.activeBacklog.title,
        ...(contextPath === undefined ? {} : { contextPath }),
      }));
    } else {
      segments.push({ label: 'goal task statement', text: taskStatement });
    }
    if (step.id === 'implement') {
      const rework = this.activeRework ? formatReworkContext(this.activeRework) : '';
      const acCorrection = this.acFeedback ? formatAcCorrection(this.acFeedback) : '';
      if (rework) segments.push({ label: 'rework context', text: rework.trim() });
      if (acCorrection) segments.push({ label: 'AC correction', text: acCorrection.trim() });
    }
    if (this.preparedRepositories) {
      const repositories = this.preparedRepositories.repositories.map((repository, index) => {
        const targetBranch = repository.targetBranch ?? repository.baseBranch;
        const boundary = describePublishBoundary({
          workingBranch: repository.workingBranch,
          targetBranch,
          baseBranch: repository.baseBranch,
          ...(repository.sourceBranch ? { sourceBranch: repository.sourceBranch } : {}),
        });
        const listing = `${index + 1}. ${repository.primary ? 'primary' : 'secondary'} checkoutPath=${repository.checkoutPath} baseBranch=${repository.baseBranch} targetBranch=${targetBranch}${repository.sourceBranch ? ` sourceBranch=${repository.sourceBranch}` : ''} workingBranch=${repository.workingBranch}`;
        return `${listing}\n   ${boundary}`;
      }).join('\n');
      segments.push({
        label: 'execution repositories',
        text: `Execution repositories:\n${repositories}\nPaths are relative to the execution workspace root.`,
      });
    }
    return segments;
  }

  private resolveStepSignalType(_role: string): 'goal_complete' {
    return 'goal_complete';
  }

  private async runStep(
    step: Step,
    ctx: StepRunCtx,
    stepResults: Record<string, StepResult>,
  ): Promise<StepResult> {
    const startedAt = new Date().toISOString();
    const typedStep = step as Step & { completionSignal?: 'goal_complete' };
    const signalType = typedStep.completionSignal ?? this.resolveStepSignalType(step.role ?? 'agent');
    const effectiveTimeout = step.timeoutMs ?? ctx.hardTimeoutMs;

    // Determine worktree: reuse primary for step 0 in group 0, or when the
    // step's branch config uses the iid:0 placeholder (should reuse primary).
    // Create a new worktree only for concurrent/branched steps with a real iid.
    let branchHandle: BranchHandle;
    const branchConfig = step.branch;
    // A step without an explicit branch reuses the provider-created primary worktree.
    if (!shouldReusePrimaryWorktree(branchConfig)) {
      // Non-placeholder explicit branch: create a dedicated worktree (for parallel branches).
      branchHandle = await this.prepareStepWorktree(branchConfig, ctx.iid, ctx.baseBranch);
      this.stepBranchHandles.push(branchHandle);
      this.resourceScope?.registerStepHandle(
        { branch: branchHandle.branch, path: branchHandle.path, isNewBranch: branchHandle.isNewBranch },
        () => this.providers.branches.cleanup(branchHandle.path, { preserve: false }),
      );
    } else {
      // Placeholder (iid:0) or no explicit branch: reuse primary worktree.
      branchHandle = { branch: ctx.primaryBranch, path: ctx.primaryWtPath, isNewBranch: false };
    }

    // The goal is resolved after the worktree is known: the backlog context
    // is written into the worktree the agent works in.
    const segments = await this.resolveStepPrompt(step, ctx, branchHandle.path);
    const prompt = assemblePrompt(segments);

    // A local interactive session must own one workflow phase. Reusing the
    // implementation TUI for AC verification can submit the next prompt while
    // Claude is still returning from the previous one, losing that prompt.
    const needsDedicatedSandbox = ctx.executionMode === 'interactive' || branchHandle.path !== ctx.primaryWtPath;
    const sandbox = needsDedicatedSandbox
      ? await this.sandboxProvider.create({ worktreePath: branchHandle.path, session: ctx.session, branch: branchHandle.branch, tmux: this.tmux, executionMode: ctx.executionMode, workspaceRoot: this.workspaceRoot, runtimeRunId: this.runtimeRunId })
      : this.sandbox!;
    if (sandbox !== this.sandbox) {
      this.stepSandboxes.push(sandbox);
      this.resourceScope?.registerSandbox(sandbox);
    }
    await this.heartbeatRuntime({ worktree: branchHandle.path, branch: branchHandle.branch, progress: `running ${step.id}` });
    const completionKind: CompletionKind = step.id === 'verify-ac' ? 'ac' : 'task';
    const observationPhase = completionKind === 'ac' ? 'verification' : 'implementation';
    await this.recordObservation({ kind: 'step.started', stepId: step.id, phase: observationPhase });
    let phase: PhaseResult;
    try {
      phase = await this.runPhase({
        iid: ctx.iid,
        session: ctx.session,
        wtPath: branchHandle.path,
        hardTimeoutMs: effectiveTimeout,
        completionTimeoutMs: ctx.completionTimeoutMs,
        idleTimeoutMs: ctx.idleTimeoutMs,
        contextHighTokens: ctx.contextHighTokens,
        budget: ctx.budget,
        persistBudget: ctx.persistBudget,
        prompt,
        segments,
        signalType,
        executionMode: ctx.executionMode ?? 'batch',
        agentProvider: step.provider ? createAgentProvider(step.provider) : this.agentProvider,
        runtime: this.agentRuntime,
        sandbox,
        completionKind,
      });
    } catch (error) {
      await this.recordObservation({ kind: 'step.completed', stepId: step.id, outcome: 'failed' });
      throw error;
    } finally {
      if (sandbox !== this.sandbox && ctx.executionMode === 'interactive') await sandbox.close();
    }

    const completedAt = new Date().toISOString();
    const acFailure = completionKind === 'ac' ? parseAcVerificationFailure(phase.output) : undefined;
    const completed = completionKind === 'ac'
      ? phase.completed && isAcVerificationPass(phase.output)
      : phase.completed;
    await this.recordObservation({ kind: 'step.completed', stepId: step.id, outcome: completed ? 'succeeded' : 'failed' });
    return {
      stepId: step.id,
      status: completed ? 'completed' : 'failed',
      summary: acFailure?.summary ?? (phase.completed ? 'AC verifier returned an invalid completion payload' : 'agent step did not complete'),
      output: acFailure,
      branch: branchHandle.branch,
      worktreePath: branchHandle.path,
      startedAt,
      completedAt,
    };
  }

  private async prepareStepWorktree(
    config: unknown,
    iid: number,
    baseBranch: string,
  ): Promise<BranchHandle> {
    if (!this.activeBacklog) throw new Error('backlog is not active');
    const handle = await this.providers.branches.createVerificationWorktree(this.activeBacklog, baseBranch);
    return { branch: handle.branchName, path: handle.worktreePath, isNewBranch: true };
  }

  /**
   * Run lifecycle hooks for the active modules. `hooks` selects which phase(s)
   * to fire per module (in order); `reverse` runs modules in reverse order
   * (the cleanup path). Safe to call multiple times - modules are idempotent.
   *
   * Consolidates the previous 3x-duplicated invocation (runLifecycleCleanup
   * + the inline before/after loops in runBody) behind one helper.
   */
  private async runLifecycleHooks(
    hooks: ('before' | 'after' | 'cleanup')[],
    ctx: LifecycleContext,
    reverse = false,
  ): Promise<void> {
    if (this.lifecycleDispatcher) {
      for (const hook of hooks) {
        const phase = hook === 'before' ? 'before-agent' : hook === 'after' ? 'after-agent' : 'cleanup';
        await this.lifecycleDispatcher.run(phase, ctx);
      }
      return;
    }
    const modules = reverse ? [...this.modules].reverse() : this.modules;
    for (const mod of modules) {
      for (const hook of hooks) {
        try {
          if (hook === 'before') await mod.onBeforeAgent?.(ctx);
          else if (hook === 'after') await mod.onAfterAgent?.(ctx);
          else await mod.onCleanup?.(ctx);
          logger.info({ iid: ctx.iid, module: mod.name, hook }, 'lifecycle hook succeeded');
        } catch (err) {
          logger.warn({ iid: ctx.iid, module: mod.name, err }, `lifecycle ${hook} hook failed`);
        }
      }
    }
  }

  /**
   * Run the onInit hook on every module. Distinct from runLifecycleHooks
   * because onInit failures throw — init is infrastructure (e.g., chdir to
   * the target repo), and silently swallowing it would leave every
   * downstream operation pointed at the wrong directory.
   */
  private async runInitHooks(ctx: InitContext): Promise<void> {
    if (this.lifecycleDispatcher) {
      await this.lifecycleDispatcher.run('init', ctx);
      return;
    }
    for (const mod of this.modules) {
      if (mod.onInit) {
        logger.info({ iid: ctx.iid, module: mod.name, projectName: ctx.projectName }, 'lifecycle onInit');
        await mod.onInit(ctx);
      }
    }
  }

  private async runBody(ctx: {
    iid: number; session: string; targetBranch: string;
    baseBranch: string; hardTimeoutMs: number; completionTimeoutMs: number; idleTimeoutMs: number;
    maxHandoffs: number; contextHighTokens: number; maxTotalTokens: number;
    projectName?: string;
    repoRoot: string;
    workspaceRoot: string;
    branchStrategy?: BranchStrategyConfig;
    template: string;
    executionMode?: ExecutionMode;
  }): Promise<{ success: boolean; url?: string }> {
    const { iid, session, targetBranch, baseBranch, hardTimeoutMs, completionTimeoutMs, idleTimeoutMs, maxHandoffs, contextHighTokens, maxTotalTokens, projectName, repoRoot, workspaceRoot, branchStrategy, template, executionMode } = ctx;
    if (!this.activeBacklog) throw new Error('backlog is not active');
    const budgetStore = new BudgetStore(workspaceRoot, this.activeBacklog.workItemId ?? this.activeBacklog.providerRef);
    const savedBudget = await budgetStore.load();
    const budget = savedBudget
      ? BudgetManager.fromSnapshot(savedBudget, maxHandoffs, maxTotalTokens)
      : new BudgetManager(maxHandoffs, maxTotalTokens);
    const persistBudget = async (): Promise<void> => { await budgetStore.save(budget.snapshot()); };
    if (budget.isExhausted()) {
      const failure = await this.classifyFailure(createFailureDiagnostic({
        code: 'budget_exhausted',
        message: `work item budget exhausted: ${budget.exhaustionReason()}`,
      }));
      await this.markBacklogBlocked(failure.message);
      return { success: false };
    }
    await persistBudget();

    // ── Step 0: Init hooks (pre-worktree) ─────────────────────────────────
    // ProjectResolverModule runs here and may chdir to the target repo.
    // Init failures throw — init is infrastructure, not opt-in.
    await this.runInitHooks({
      iid, projectName, baseBranch, params: this.extParams, originalCwd: this.originalCwd, repoRoot,
      repositories: this.preparedRepositories?.repositories,
    });
    logger.info({ iid, projectName, baseBranch, moduleCount: this.modules.length }, 'init hooks complete');

    // ── Step 1: Create worktree ─────────────────────────────────────────────
    let wt: { iid: number; path: string; branch: string; createdAt: Date; status: 'active' };
    if (!this.activeBacklog) throw new Error('backlog is not active');
    if (this.preparedRepositories) {
      this.primaryHandle = this.preparedRepositories.primary.handle;
      wt = {
        iid,
        path: this.primaryHandle.path,
        branch: this.primaryHandle.branch,
        createdAt: new Date(),
        status: 'active',
      };
    } else {
      const handle = await this.providers.branches.createBranch(this.activeBacklog, baseBranch);
      this.primaryHandle = { branch: handle.branchName, path: handle.worktreePath, isNewBranch: true };
      wt = { iid, path: handle.worktreePath, branch: handle.branchName, createdAt: new Date(), status: 'active' };
    }
    logger.info({ iid, worktree: wt.path, branch: wt.branch }, 'worktree created');
    for (const path of this.preparedRepositories?.repositories.map(repository => repository.handle.path) ?? [wt.path]) {
      this.implementationBaseShas.set(path, (await simpleGit(path).revparse(['HEAD'])).trim());
    }
    await this.recordObservation({ kind: 'workspace.prepared', branch: wt.branch, workspace: wt.path, baseBranch });
    logger.info({ iid, status: 'active' }, 'worktree status updated');
    if (this.executionMode === 'interactive') {
      await configureStatusline(wt.path);
      logger.info({ iid, worktree: wt.path }, 'statusline configured');
    }

    // ── Step 1b: Lifecycle before_agent hooks ──────────────────────────────
    this.lifecycleCtx = {
      iid, worktreePath: wt.path, baseBranch, sessionName: session, params: this.extParams, repoRoot,
      projectName, originalCwd: this.originalCwd, repositories: this.preparedRepositories?.repositories,
    };
    await this.runLifecycleHooks(['before'], this.lifecycleCtx);
    logger.info({ iid, hook: 'before_agent', moduleCount: this.modules.length }, 'lifecycle before_agent hooks complete');

    // ── Step 2: Create sandbox (local: tmux session + prompt wait) ─────────
    this.sandbox = await this.sandboxProvider.create({
      worktreePath: wt.path,
      session,
      branch: targetBranch,
      tmux: this.tmux,
      executionMode: this.executionMode,
      workspaceRoot,
      runtimeRunId: this.runtimeRunId,
    });
    this.resourceScope?.registerSandbox(this.sandbox);
    logger.info({ iid, session, worktree: wt.path, sandboxId: this.sandbox.id }, 'sandbox created');

    // ── Step 3: Launch watchdog (detached, no blocking) ────────────────────
    this.watchdog.arm(session, hardTimeoutMs, iid, wt.path);
    logger.info({ iid, session, hardTimeoutMs }, 'watchdog armed');

    // ── Step 4: Post launch comment ────────────────────────────────────────
    await this.transitionBacklog(iid, 'in_progress');

    // ── Phases: implement then verify; handoff budgets are shared across both ──
    // used = handoff rounds, tokens = accumulated total across generations.
    const stepResults: Record<string, StepResult> = {};

    // ── Template execution: compilation + typed dispatch ─────────────────────
    logger.info({ iid, template }, 'using compiled execution plan');
    const loadedTemplate = await new TemplateLoader({ projectRoot: repoRoot }).load(template);
    await this.recordObservation({
      kind: 'workflow.recorded', name: loadedTemplate.name, version: loadedTemplate.version,
      steps: loadedTemplate.steps.map(step => ({
        id: step.id, kind: step.kind ?? 'agent', dependsOn: step.dependsOn ?? [],
        ...(step.kind === 'system' ? {} : { provider: step.provider ?? this.agentProvider.name, executionMode: step.executionMode ?? executionMode ?? 'batch' }),
      })),
    });
    const autoWrapupOverridden = this.autoWrapup !== WorkflowRunner.prototype.autoWrapup;
    const systemActions = new SystemActionExecutor({
      publishChange: async () => {
        if (autoWrapupOverridden) return { url: undefined };
        if (this.preparedRepositories) {
          this.systemActionsRan = true;
          return { url: undefined };
        }
        await this.recordImplementationCommit(wt.path, wt.branch);
        await this.providers.branches.push(wt.branch, wt.path);
        this.systemActionsRan = true;
        return { url: undefined };
      },
      queueQA: async () => {
        if (autoWrapupOverridden) return { queued: true };
        if (!this.preparedRepositories) await this.transitionBacklog(iid, 'verification');
        this.systemActionsRan = true;
        return { queued: true };
      },
      plugins: this.plugins,
    });
    const executor = new PlanExecutor({
      executeAgent: (step, results) => this.runStep(step, {
        iid, session: `${session}-${step.id}`, baseSession: session,
        primaryWtPath: wt.path, primaryBranch: wt.branch, baseBranch,
        hardTimeoutMs, completionTimeoutMs, idleTimeoutMs, contextHighTokens, budget, stepIndex: 0,
        executionMode: step.executionMode ?? executionMode, persistBudget,
      }, results),
      executeSystem: async step => {
        const startedAt = new Date().toISOString();
        try {
          const output = await systemActions.execute(step.action, { iid, worktreePath: wt.path, branch: wt.branch, targetBranch });
          return { stepId: step.id, status: 'completed', output, startedAt, completedAt: new Date().toISOString() };
        } catch (error) {
          return { stepId: step.id, status: 'failed', summary: (error as Error).message, startedAt, completedAt: new Date().toISOString() };
        }
      },
      systemActions: this.plugins?.listSystemActions(),
    });
    const executedResults = await executor.execute(loadedTemplate);
    Object.assign(stepResults, executedResults);
    const verification = stepResults['verify-ac'];
    if (verification?.status === 'failed') {
      const recovered = await this.retryFailedAcVerification(loadedTemplate, {
        iid, session, baseSession: session, primaryWtPath: wt.path, primaryBranch: wt.branch, baseBranch,
        hardTimeoutMs, completionTimeoutMs, idleTimeoutMs, contextHighTokens, budget, executionMode, persistBudget,
      }, verification, stepResults);
      if (recovered) {
        if (!this.preparedRepositories) {
          await this.recordImplementationCommit(wt.path, wt.branch);
          await this.providers.branches.push(wt.branch, wt.path);
          await this.transitionBacklog(iid, 'verification');
        }
        this.systemActionsRan = true;
      }
    }
    const failedStep = Object.values(stepResults).find(result => result.status === 'failed' || result.status === 'timed_out' || result.status === 'aborted');
    if (failedStep) {
      // A step that did not complete is the run's reason, not the run's
      // summary: without it the run ends with 'workflow execution failed'.
      await this.classifyFailure(diagnoseStepFailure(failedStep));
      return { success: false };
    }

    // ── Lifecycle after_agent hooks (before cleanup) ────────────────────────
    await this.runLifecycleHooks(['after'], this.lifecycleCtx);
    logger.info({ iid, hook: 'after_agent', moduleCount: this.modules.length }, 'lifecycle after_agent hooks complete');

    // Keep the explicit autoWrapup seam usable for legacy embedders/tests that
    // replace it; production typed templates use the system-action terminalizer.
    if (this.systemActionsRan && !autoWrapupOverridden) {
      await this.cleanupPrimary(iid, true);
      return { success: true };
    }
    return this.autoWrapup(iid, wt.path, session, targetBranch);
  }

  private async cleanupPrimary(iid: number, force: boolean): Promise<void> {
    try {
      if (this.preparedRepositories) return;
      if (!this.primaryHandle) return;
      await this.providers.branches.cleanup(this.primaryHandle.path, { preserve: !force });
    } catch (error) {
      logger.warn({ iid, error }, 'failed to remove primary worktree');
    }
  }

  private finishPreparedRepositories(outcome: { status: RunOutcomeStatus }): Promise<void> {
    if (!this.preparedRepositories) return Promise.resolve();
    this.preparedRepositoryFinish ??= this.preparedRepositories.finish(outcome).catch(error => {
      // The failure is classified by the caller that owns the audit event;
      // recording it here as well would put the same failure into the chain
      // twice.
      logger.warn({ error }, 'prepared repository publication failed');
      throw error;
    }).finally(() => this.stopRepositoryHeartbeat?.());
    return this.preparedRepositoryFinish;
  }

  /**
   * Post-success implementation cleanup: push branch, transition to verification,
   * close sandbox, and clean up the worktree. QA owns change creation.
   * Called after all steps complete (template or legacy).
   */
  private async autoWrapup(iid: number, worktreePath: string, session: string, targetBranch: string): Promise<{ success: boolean; url?: string }> {
    if (this.leaseLost) {
      await this.markBacklogBlocked('claim heartbeat failed');
      return { success: false };
    }
    await this.commitImplementationWork(iid, worktreePath);
    await this.recordImplementationCommit(worktreePath, targetBranch);
    if (!this.preparedRepositories) {
      // Push the implementation branch. QA creates the change request only
      // after merging the latest baseline and running integration tests.
      await this.pushBranch(worktreePath);
      logger.info({ iid, worktreePath }, 'branch pushed');
    }

    if (this.leaseLost) {
      await this.markBacklogBlocked('claim heartbeat failed');
      return { success: false };
    }

    if (!this.preparedRepositories) await this.transitionBacklog(iid, 'verification');

    await this.cleanupPrimary(iid, true);
    logger.info({ iid, worktreePath }, 'worktree cleaned up');

    return { success: true };
  }

  /**
   * Commit the agent's work.
   *
   * AFK publishes the implementation, so AFK owns the commit. An agent that
   * leaves its changes uncommitted would otherwise publish an empty change,
   * and the work would be lost when the workspace is restored.
   */
  private async commitImplementationWork(iid: number, worktreePath: string): Promise<string> {
    const title = this.activeBacklog?.title?.trim();
    const message = `feat: ${title ? `${title} ` : ''}(backlog ${iid})`;
    const commit = await this.providers.branches.commit(worktreePath, message);
    if (commit.skippedBinaryFiles.length > 0) {
      // A binary leftover has no text to merge. Publishing it would make the
      // change request unmergeable the moment the target branch touches the
      // same file, so it stays in the worktree and is reported here.
      logger.warn({ iid, worktreePath, skippedBinaryFiles: commit.skippedBinaryFiles },
        'binary files left out of the implementation commit');
    }
    if (commit.sha) logger.info({ iid, worktreePath, commitSha: commit.sha }, 'implementation committed');
    return commit.sha;
  }

  private async recordImplementationCommit(worktreePath: string, branch: string): Promise<void> {
    const base = this.implementationBaseShas.get(worktreePath);
    if (!base) return;
    const head = (await simpleGit(worktreePath).revparse(['HEAD'])).trim();
    if (head === base || head === this.implementationCommitShas.get(worktreePath)) return;
    await this.recordObservation({ kind: 'commit.recorded', phase: 'implementation', commitSha: head, branch });
    this.implementationCommitShas.set(worktreePath, head);
  }

  /**
   * Handle hard timeout: capture session and transition the backlog,
   * and tear down local resources. The timeout is one of the explicit
   * terminal paths - it owns its own cleanup.
   */
  private async handleTimeout(
    iid: number,
    worktreePath: string,
    session: string,
    timeoutMs: number,
    reason = 'workflow timeout'
  ): Promise<void> {
    const snapshot = await this.tmux.capturePane(session, 'main', { lines: 100, history: 1000 });
    const logPath = join(this.timeoutSnapshotDir, `timeout-${iid}-${Date.now()}.log`);

    await fs.mkdir(this.timeoutSnapshotDir, { recursive: true });
    await fs.writeFile(logPath, snapshot, 'utf-8');

    try {
      await this.transitionBacklog(iid, 'blocked', reason);
    } catch (err) {
      logger.error({ iid, err }, 'failed to update GitHub on timeout');
    }

    await this.teardownSession(iid, session);
    // Lifecycle cleanup hooks (zeroed context, same as cleanupOnFailure).
    try {
      await this.runLifecycleHooks(
        ['after', 'cleanup'],
        { iid: 0, worktreePath: '', baseBranch: '', sessionName: '', params: this.extParams },
        true,
      );
    } catch (err) {
      logger.warn({ iid, err }, 'lifecycle cleanup failed after timeout');
    }
  }

  /**
   * Run one workflow phase (implement / verify) as a loop: send the goal,
   * wait for the completion signal or context overflow, and on verified
   * context_high delegate to the HandoffCoordinator (auto-relaunch or
   * terminal), until the phase completes or the handoff budget is exhausted.
   *
   * The runner owns the phase loop and the budget decisions (WHEN to hand
   * off); the coordinator owns the handoff execution (HOW).
   */
  private async runPhase(p: {
    iid: number;
    session: string;
    wtPath: string;
    hardTimeoutMs: number;
    completionTimeoutMs: number;
    idleTimeoutMs: number;
    contextHighTokens: number;
    budget: BudgetManager;
    persistBudget: () => Promise<void>;
    prompt: string;
    /** The goal's pieces, so an over-long prompt can name the guilty one. */
    segments?: PromptSegment[];
    signalType: 'goal_complete';
    executionMode?: ExecutionMode;
    agentProvider?: AgentProvider;
    runtime?: AgentRuntimeSelection;
    sandbox?: Sandbox;
    completionKind: CompletionKind;
  }): Promise<PhaseResult> {
    const basePrompt = p.prompt ?? (p as unknown as { goalBase?: string }).goalBase ?? '';
    let resumedExecution: AgentExecution | undefined;
    let agentFailures = 0;
    for (let round = 1; ; round++) {
      if (!resumedExecution && p.budget.isExhausted() && round === 1) {
        const failure = await this.classifyFailure(createFailureDiagnostic({
          code: 'budget_exhausted',
          message: `work item budget exhausted: ${p.budget.exhaustionReason()}`,
        }));
        await this.markBacklogBlocked(failure.message);
        return { completed: false };
      }
      const rawPrompt = round === 1
        ? basePrompt
        : this.continuePrompt(basePrompt, p.iid, p.wtPath, round - 1);
      const goalSegments = round === 1 && p.segments ? p.segments : [{ label: 'goal', text: rawPrompt }];
      const segments = buildExecutionPromptSegments(goalSegments, p.executionMode, p.completionKind);
      const prompt = assemblePrompt(segments);

      logger.info({ iid: p.iid, round, signalType: p.signalType, budgetUsed: p.budget.used }, 'round begin');

      const agentProvider = p.agentProvider ?? this.agentProvider;
      const sandbox = p.sandbox ?? this.sandbox!;
      if (this.leaseLost) throw new Error('claim lease lost before agent start');
      // A goal the provider would refuse is refused here, where the length
      // and the limit are still known. Dispatching it would cost the whole
      // idle timeout and produce a timeout instead of a cause.
      const budget = measurePromptBudget({ prompt, parts: segments, limits: agentProvider.promptLimits });
      if (budget.exceeded) {
        const failure = await this.classifyFailure(createFailureDiagnostic({
          code: 'prompt_budget_exceeded',
          message: `the agent goal is ${budget.actual} characters, over the ${budget.limit}-character goal condition limit the ${agentProvider.name} provider enforces`,
          evidence: [
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
              actual: `the backlog context is already written to ${BACKLOG_CONTEXT_PATH}; shorten the task statement or the completion protocol, or raise the goal limit the ${agentProvider.name} provider declares`,
            },
          ],
        }));
        await this.markBacklogBlocked(failure.message);
        return { completed: false };
      }
      const execution = resumedExecution ?? await agentProvider.createExecution({
        sandbox,
        worktreePath: p.wtPath,
        sessionId: p.session,
        prompt,
        signalType: p.signalType,
        generation: p.budget.used + 1,
        executionMode: p.executionMode,
        runtime: p.runtime,
      });
      resumedExecution = undefined;
      this.resourceScope?.registerExecution(execution);
      if (this.leaseLost) {
        await execution.kill();
        throw new Error('claim lease lost during agent start');
      }
      await this.heartbeatRuntime(runtimeFieldsFromExecution(execution.metadata));
      await this.heartbeatRuntime({ phase: 'implementing', progress: `agent generation ${round}` });
      logger.info({ iid: p.iid, round, signalType: p.signalType }, 'goal sent');

      const result = await execution.waitForResult({
        completionTimeoutMs: p.completionTimeoutMs,
        contextHighTokens: p.contextHighTokens,
        idleTimeoutMs: p.idleTimeoutMs,
      });
      await this.writeRuntimeDiagnostics(result, execution);

      const telemetry = await this.recordAgentTelemetry(execution, result);
      if (telemetry) {
        p.budget.recordSession(telemetry.sessionId, telemetry.totalTokens);
        await p.persistBudget();
      }

      // A failure that says nothing about the work is not a verdict on the
      // work. The attempt is repeated in the same worktree, where the work
      // already done is still on disk. A handoff round is not consumed: this
      // is a retry of the same step, not the next attempt.
      //
      // The decision is read from the structured diagnosis, so the meaning of
      // a provider code is decided in one place.
      const diagnosis = result.status === 'completed' || result.status === 'context_high'
        ? undefined
        : diagnoseExecutionFailure(result);
      if (diagnosis?.retryable && agentFailures < this.config.maxRetries) {
        agentFailures++;
        logger.warn(
          { iid: p.iid, round, attempt: agentFailures, code: diagnosis.code, providerCode: diagnosis.providerCode },
          'the agent failed in a way that can be retried; repeating the step',
        );
        round--;
        continue;
      }

      switch (result.status) {
        case 'completed':
          return { completed: true, output: result.structuredOutput };

        case 'timed_out': {
          // A timeout is a first-class failure: it carries the budget that
          // ran out, the last time the agent did something, and why it was
          // read as a timeout rather than as a crash.
          const timeout = await this.classifyFailure(diagnosis!);
          await this.handleTimeout(p.iid, p.wtPath, p.session, p.hardTimeoutMs, timeout.message);
          return { completed: false };
        }

        case 'context_high': {
          const hctx = {
            backlogId: this.activeBacklog?.id ?? String(p.iid),
            session: p.session,
            wtPath: p.wtPath,
            hardTimeoutMs: p.hardTimeoutMs,
            gen: p.budget.used + 1,
            tokens: result.usage?.totalTokens ?? 0,
          };

          if (p.budget.isExhausted()) {
            await this.coordinator.handoff(hctx, 'terminal', p.budget.exhaustionReason()!);
            return { completed: false };
          }

          // Phase 4 — save session snapshot to the store chain before handing off.
          // This allows future native-resume rounds to restore from the snapshot.
          // Errors are best-effort and do not affect the handoff flow.
          const chain = this.sessionStoreChainFactory(p.wtPath);
          const runId = `issue-${p.iid}-gen-${p.budget.used + 1}`;
          if (sandbox) {
            try {
              const snapshot = await execution.captureSession();
              if (snapshot) {
                await chain.saveFirst({ runId, provider: this.agentProvider.name, snapshot });
                logger.info({ iid: p.iid, runId, provider: this.agentProvider.name }, 'session snapshot saved to store chain');
              }
            } catch (err) {
              logger.info({ iid: p.iid, runId, err }, 'session snapshot save failed; proceeding with handoff');
            }
          }

          const reserveHandoff = async (): Promise<void> => {
            if (!p.budget.canHandoff()) throw new Error('work item handoff budget exhausted');
            p.budget.recordHandoff();
            await p.persistBudget();
          };
          resumedExecution = await attemptNativeResume(
            {
              iid: p.iid,
              session: p.session,
              wtPath: p.wtPath,
              runId,
              generation: p.budget.used + 2,
              signalType: p.signalType,
              prompt,
              executionMode: p.executionMode,
              runtime: p.runtime,
            },
            agentProvider,
            sandbox,
            () => chain,
            reserveHandoff,
          );
          if (resumedExecution) continue;
          if (!p.budget.canHandoff()) {
            const failure = await this.classifyFailure(createFailureDiagnostic({
              code: 'handoff_budget_exhausted',
              message: 'work item handoff budget exhausted',
            }));
            await this.markBacklogBlocked(failure.message);
            return { completed: false };
          }

          // Coordinator.restartSession() creates a new tmux session.
          // After it returns, the loop continues and sends the continued goal in the next iteration.
          // This mirrors the original behavior exactly.
          await reserveHandoff();
          if ((await this.coordinator.handoff(hctx, 'auto')) === 'continued') {
            logger.info({ iid: p.iid, round, generation: p.budget.used + 1 }, 'handoff continued; looping to send continued goal');
            continue;
          }
          return { completed: false }; // auto-handoff flipped to manual; phase over
        }

        default:
          // 'failed', 'blocked', 'aborted' — treat as failure
          const failure = await this.classifyFailure(diagnosis!);
          logger.warn(
            { iid: p.iid, status: result.status, code: failure.code, providerCode: failure.providerCode },
            'execution returned non-success status',
          );
          if (round === 1) {
            // Initial round failure: unchanged crash path
            throw new Error(`execution failed: ${failure.message}`);
          }
          await this.manualFlip(p.iid, p.session);
          return { completed: false };
      }
    }
  }

  private async retryFailedAcVerification(
    template: import('../domain/templates/types.js').WorkflowTemplate,
    ctx: Omit<StepRunCtx, 'stepIndex'>,
    initial: StepResult,
    results: Record<string, StepResult>,
  ): Promise<boolean> {
    let failure = parseAcVerificationFailure(initial.output);
    const implement = template.steps.find(step => step.id === 'implement');
    const verify = template.steps.find(step => step.id === 'verify-ac');
    if (!failure || !implement || !verify) return false;

    for (let iteration = 1; iteration <= this.config.maxSelfIterations; iteration++) {
      this.acFeedback = failure;
      await this.heartbeatRuntime({ progress: `AC correction ${iteration}/${this.config.maxSelfIterations}` });
      const implementation = await this.runStep(implement, { ...ctx, stepIndex: iteration }, results);
      results.implement = implementation;
      if (implementation.status !== 'completed') break;
      const verification = await this.runStep(verify, { ...ctx, stepIndex: iteration }, results);
      results['verify-ac'] = verification;
      if (verification.status === 'completed') {
        this.acFeedback = undefined;
        return true;
      }
      failure = parseAcVerificationFailure(verification.output);
      if (!failure) break;
    }
    this.acFeedback = undefined;
    return false;
  }

  /**
   * Poll for phase signals AND objective context overflow. The agent cannot
   * reliably detect its own context limit (TUI warnings are rendering-layer
   * only), so the runner polls the statusline token data directly.
   *
   * Each wait gets a full completionTimeoutMs budget (re-armed after a
   * handoff); the watchdog's hardTimeoutMs - also re-armed per generation -
   * is the real ceiling on total phase duration.
   */

  /** Prompt for a resumed round: read the handoff doc(s) before continuing. */
  private continuePrompt(prompt: string, iid: number, wtPath: string, gen: number): string {
    const docPath = handoffDocPath(wtPath, this.activeBacklog?.id ?? String(iid), gen);
    const continuation = prompt.replace(/^\/goal\s*/i, '');
    return `继续${continuation}（上下文已交接，请先阅读交接文档 ${docPath}；若存在更早的交接文档（同目录 handoff-${iid}-*.md），请一并阅读以获取完整上下文，再继续）`;
  }

  /**
   * Mark the issue for manual resume and kill the session. Used when sendGoal
   * itself fails on a resumed round (a runner-level failure, distinct from the
   * coordinator's internal relaunch-failure flip).
   */
  private async manualFlip(iid: number, session: string): Promise<void> {
    await this.markBacklogBlocked('handoff failed');
    await this.tmux.killSession(session).catch(() => { /* already dead */ });
    await this.tmux.closeSession();
  }

  /**
   * Push worktree branch to origin
   */
  private async pushBranch(worktreePath: string): Promise<void> {
    const git = simpleGit(worktreePath);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    await this.providers.branches.push(branch, worktreePath);
  }

  private async transitionBacklog(iid: number, state: BacklogState, reason?: string): Promise<void> {
    const id = this.activeBacklog?.id ?? String(iid);
    if (state === 'verification' && this.activeClaim) {
      try {
        await this.activeClaim.heartbeat();
      } catch (error) {
        this.leaseLost = true;
        await this.markBacklogBlocked(`claim lease lost before verification: ${(error as Error).message}`);
        throw error;
      }
    }
    await this.providers.backlog.transition(id, state, reason ? { reason } : undefined);
    if (state === 'blocked') await this.providers.backlog.setExecutionMode(id, 'hitl');
  }

  private async markBacklogBlocked(reason: string): Promise<void> {
    if (!this.providers || !this.activeBacklog) return;
    try {
      await blockBacklog(this.providers.backlog, this.activeBacklog.id, reason);
    } catch (error) {
      logger.warn({ backlogId: this.activeBacklog.id, error }, 'failed to mark backlog blocked');
    }
  }

  private createObservationContext(backlogId: string, session: string, options: RunnerOptions): ObservationContext {
    const runId = options.observationRunId ?? `afk-${backlogId}-${randomUUID()}`;
    return {
      traceId: runId,
      runId,
      workItemId: options.observationWorkItemId ?? options.workItemId ?? backlogId,
      profileId: process.env.AFK_PROFILE ?? 'local',
      attempt: 1,
      actor: { kind: 'system', id: session },
    };
  }

  private async recordObservation(data: RunEventData): Promise<void> {
    if (!this.observationContext) throw new AuditPersistenceError(data.kind, 'observation context unavailable');
    try {
      await this.observer.record(this.observationContext, data);
    } catch (error) {
      logger.error({ runId: this.observationContext.runId, eventType: data.kind, err: error }, 'failed to persist run audit event');
      throw new AuditPersistenceError(data.kind, error);
    }
  }

  private async recordAgentTelemetry(execution: AgentExecution, result: ExecutionResult): Promise<{ sessionId: string; totalTokens: number } | undefined> {
    const sandboxKind: 'local' | 'container' =
      this.sandboxProvider.name === 'docker' || this.sandboxProvider.name === 'podman' ? 'container' : 'local';
    const telemetry = await collectAgentTelemetry(execution, result, sandboxKind);
    const { sessionId, usage } = telemetry;
    if (!this.observationContext) return usage ? { sessionId, totalTokens: usage.totalTokens } : undefined;
    try {
      await this.observer.record(this.observationContext, {
        kind: 'agent.session_recorded',
        ...telemetry,
      });
    } catch (err) {
      logger.info({ runId: this.observationContext.runId, err }, 'agent.session_recorded: telemetry not persisted (non-fatal)');
    }
    return usage ? { sessionId, totalTokens: usage.totalTokens } : undefined;
  }

  private async startRuntime(backlogId: string, session: string): Promise<void> {
    if (this.runtimeRunId) return;
    const now = new Date().toISOString();
    this.runtimeRunId = this.observationContext?.runId ?? `${session}-${Date.now()}`;
    try {
      await this.runtimeManager.start({
        runId: this.runtimeRunId,
        backlogId,
        workspace: this.repoRoot,
        providerRef: this.activeBacklog?.providerRef,
        title: this.activeBacklog?.title,
        phase: 'implementing',
        status: 'running',
        sandboxProvider: this.sandboxProviderName,
        executionMode: this.executionMode,
        agentProvider: this.agentProviderName,
        ...runtimeFieldsFromSelection(this.agentProviderName, this.agentRuntime),
        session,
        branch: this.activeBacklog?.branchName,
        startedAt: now,
        heartbeatAt: now,
        progress: 'claimed',
      });
    } catch (error) {
      logger.warn({ backlogId, error }, 'failed to publish workflow runtime');
      this.runtimeRunId = undefined;
    }
  }

  private async heartbeatRuntime(changes: Parameters<TaskRuntimeManager['heartbeat']>[1]): Promise<void> {
    if (!this.runtimeRunId) return;
    try {
      await this.runtimeManager.heartbeat(this.runtimeRunId, changes);
    } catch (error) {
      logger.warn({ runId: this.runtimeRunId, error }, 'failed to update workflow runtime');
    }
  }

  private async finishRuntime(status: 'completed' | 'blocked', progress: string): Promise<void> {
    if (!this.runtimeRunId) return;
    try {
      await this.runtimeManager.finish(this.runtimeRunId, {
        status,
        progress,
        errorSummary: status === 'blocked' ? this.runtimeErrorSummary ?? 'workflow execution failed' : undefined,
      });
    } catch (error) {
      logger.warn({ runId: this.runtimeRunId, error }, 'failed to archive workflow runtime');
    }
  }

  private async writeRuntimeDiagnostics(result: ExecutionResult, execution: AgentExecution): Promise<void> {
    if (!this.runtimeRunId) return;
    try {
      const output = await execution.captureOutput({ lines: 200, history: 2_000 });
      await this.runtimeManager.writeDiagnostics(this.runtimeRunId, { result, output });
      const structured = result.structuredOutput as { result?: string; summary?: string } | undefined;
      const failed = result.status !== 'completed' || structured?.result === 'FAIL';
      await this.runtimeManager.appendActivity(this.runtimeRunId, {
        kind: failed ? 'error' : 'test',
        message: structured?.summary ?? (failed ? 'acceptance verification failed' : 'acceptance verification completed'),
      });
    } catch (error) {
      logger.warn({ runId: this.runtimeRunId, error }, 'failed to persist workflow runtime diagnostics');
    }
  }

}
