import { promises as fs } from 'fs';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import { WorktreeManager } from '../infrastructure/git/index';
import { TmuxClient, createTmuxClient } from '../infrastructure/tmux/index';
import { createSandboxProvider } from '../infrastructure/sandbox/index';
import { createAgentProvider } from '../domain/agents/index';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderName,
  AgentExecution,
  ExecutionResult,
} from '../infrastructure/sandbox/types';
import type { AgentProvider, AgentProviderName, SessionSnapshot, ExecutionMode } from '../domain/agents/types';
import { getTokenUsage, configureStatusline, logger } from '../infrastructure/io/index';
import { getWorkflowConfig } from '../infrastructure/config/manager';
import { loadModules, parseModuleParams } from './modules/_registry';
import type { ModuleParams } from './modules/_registry';
import { LifecycleDispatcher, type LifecycleModule, type LifecycleContext } from './workflows/lifecycle';
import { Watchdog, createWatchdog } from './workflows/watchdog';
import type { WorkflowConfig } from '../infrastructure/config/manager';
import { HandoffCoordinator, handoffDocPath } from './workflows/handoff';
import { attemptNativeResume } from './workflows/resume';
import { BudgetManager } from './workflows/budget';
import type { InitContext } from './workflows/lifecycle';
import { defaultSessionStoreChain } from './sessions/chain';
import { TemplateLoader } from '../domain/templates/loader';
import { PlanExecutor } from './workflows/plan-executor';
import { SystemActionExecutor } from './workflows/system-actions';
import { RunResourceScope, type RunOutcomeStatus } from './workflows/resource-scope';
import {
  buildExecutionPrompt,
  isAcVerificationPass,
  parseAcVerificationFailure,
  type AcVerificationFailure,
  type CompletionKind,
} from './workflows/execution-protocol';
import { shouldReusePrimaryWorktree } from './workflows/worktree-selection';
import type { PluginRuntime } from './plugins/runtime';
import type { Step, StepResult } from '../domain/templates/types';
import type { BranchHandle } from '../domain/branches/types';
import type { ProviderBundle } from './providers';
import type { BacklogClaim, BacklogItem, BacklogState } from '../domain/backlog/index';
import { TaskRuntimeManager } from './runtime/task-runtime';

/**
 * Preserve the provider boundary details when an agent execution fails.
 * The result may contain provider-native structured output, so keep it in the
 * message without assuming a particular provider schema.
 */
export function formatExecutionFailure(result: ExecutionResult): string {
  const details = [
    `status=${result.status}`,
    `provider=${result.provider}`,
    `runId=${result.runId}`,
    result.sessionId ? `sessionId=${result.sessionId}` : undefined,
    result.exitCode === undefined ? undefined : `exitCode=${result.exitCode}`,
    result.error ? `${result.error.code}: ${result.error.message}` : undefined,
    result.structuredOutput === undefined
      ? undefined
      : `structuredOutput=${safeExecutionJson(result.structuredOutput)}`,
  ].filter((value): value is string => value !== undefined);
  return details.join('; ');
}

function safeExecutionJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '[unserializable]';
  }
}

function formatCriteria(criteria: Array<{ id: string; expected: string; actual: string }>): string {
  return criteria.map(criterion => `- ${criterion.id}: expected ${criterion.expected}; actual ${criterion.actual}`).join('\n');
}

function formatAcCorrection(failure: AcVerificationFailure): string {
  return `\n\nAC correction required. Work on the current branch and repair exactly these failed acceptance criteria before the verifier runs again:\n${formatCriteria(failure.failedCriteria)}\nVerifier summary: ${failure.summary}`;
}

function formatReworkContext(rework: import('../domain/backlog/index').ReworkRecord): string {
  return `\n\nAn open QA rework record (${rework.id}, attempt ${rework.attempt}) applies to this backlog. Repair it on the current branch and run its required checks:\n${formatCriteria(rework.failedCriteria)}\nQA summary: ${rework.summary}${rework.requiredChecks.length ? `\nRequired checks:\n${rework.requiredChecks.map(check => `- ${check.command}: ${check.expected}`).join('\n')}` : ''}`;
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

export interface RunnerOptions {
  /** Canonical backlog ID. */
  backlogId: string;
  /** Local-only numeric worktree key for older git helpers. */
  iid?: number;
  session: string;
  targetBranch: string;
  baseBranch?: string;
  maxRetries?: number;
  hardTimeoutMs?: number;
  completionTimeoutMs?: number;
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
  /** Module names to activate (e.g., ['isolate', 'mock-server']) */
  ext?: string[];
  /** Module parameters (e.g., ['isolate.auto=true']) */
  extParams?: string[];
  /** Sandbox provider name (default: 'local'). */
  sandboxProvider?: SandboxProviderName;
  /** Agent provider name (default: 'claude-code'). */
  agentProvider?: AgentProviderName;
  /** Provider-resolved branch strategy metadata. */
  branchStrategy?: unknown;
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
    backlog: import('../domain/backlog/index').BacklogProvider;
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
  /** Session store chain (tests / future). Defaults to defaultSessionStoreChain. */
  sessionStoreChain?: (worktreePath: string) => import('./sessions/types').SessionStoreChain;
  /** Workflow config: all timeout and budget values. Defaults to getWorkflowConfig(). */
  config?: WorkflowConfig;
  /** Typed plugin capabilities available to this run. */
  plugins?: PluginRuntime;
  /** Canonical backlog/branch/change providers. */
  providers?: ProviderBundle;
  /** Local runtime projection for the read-only Tasks monitor. */
  runtimeManager?: TaskRuntimeManager;
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
  contextHighTokens: number;
  budget: BudgetManager;
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
  /** Session store chain factory — defaults to defaultSessionStoreChain. */
  private sessionStoreChainFactory: (worktreePath: string) => import('./sessions/types').SessionStoreChain;
  /** Resolved sandbox provider name (set in run()). */
  private sandboxProviderName: SandboxProviderName = 'local';
  /** Resolved agent provider name (set in run()). */
  private agentProviderName: AgentProviderName = 'claude-code';
  /** Execution mode (set in run()). */
  private executionMode: ExecutionMode = 'interactive';
  private sandbox: Sandbox | undefined;
  private logDir: string;
  private modules: LifecycleModule[] = [];
  private lifecycleDispatcher?: LifecycleDispatcher;
  private extParams: ModuleParams = {};
  private originalCwd: string = '';
  private repoRoot: string = '';
  private lifecycleCtx: LifecycleContext = { iid: 0, worktreePath: '', baseBranch: '', sessionName: '', params: {} };
  /** Branch handles created per step in template execution. Cleaned up in teardownSession. */
  private stepBranchHandles: BranchHandle[] = [];
  private stepSandboxes: Sandbox[] = [];
  private config: WorkflowConfig;
  private systemActionsRan = false;
  private readonly agentProviderInjected: boolean;
  private primaryHandle?: BranchHandle;
  private resourceScope?: RunResourceScope;
  private readonly plugins?: PluginRuntime;
  private readonly providers: ProviderBundle;
  private activeBacklog?: BacklogItem;
  private activeClaim?: BacklogClaim;
  private leaseLost = false;
  private readonly runtimeManager: TaskRuntimeManager;
  private runtimeRunId?: string;
  private runtimeErrorSummary?: string;
  private acFeedback?: AcVerificationFailure;
  private activeRework?: import('../domain/backlog/index').ReworkRecord;

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
  sessionStoreChainFor(worktreePath: string): import('./sessions/types').SessionStoreChain {
    return this.sessionStoreChainFactory(worktreePath);
  }

  constructor(providers: ProviderBundle, deps?: RunnerDependencies) {
    this.tmux = deps?.tmux ?? createTmuxClient();
    this.logDir = `${process.env.HOME}/.claude/logs/afk`;
    this.watchdog = deps?.watchdog ?? createWatchdog(this.logDir);
    this.config = deps?.config ?? getWorkflowConfig();
    this.plugins = deps?.plugins;
    this.providers = providers;
    this.coordinator = deps?.coordinatorFactory
      ? deps.coordinatorFactory({ backlog: providers?.backlog, tmux: this.tmux, watchdog: this.watchdog, config: this.config } as never)
      : ({ handoff: async () => 'terminal' } as unknown as HandoffCoordinator);
    this.sandboxProvider = deps?.sandboxProvider ?? createSandboxProvider('local', { worktreeManager: this.worktree });
    this.agentProviderInjected = deps?.agentProvider !== undefined;
    this.agentProvider = deps?.agentProvider ?? createAgentProvider(this.agentProviderName);
    // Default to the standard chain: FileSessionStore (native) -> HandoffSessionStore (Markdown fallback).
    this.sessionStoreChainFactory = deps?.sessionStoreChain ?? defaultSessionStoreChain;
    this.runtimeManager = deps?.runtimeManager ?? new TaskRuntimeManager();
  }

  /**
   * Full workflow: worktree -> tmux session -> /goal -> wait -> cleanup.
   * Every explicit terminal path does its own cleanup; the catch below only
   * covers unexpected exceptions (crash path), and the finally only ever
   * disarms the watchdog.
   */
  async run(options: RunnerOptions): Promise<WorkflowRunResult> {
    const {
      iid: requestedIid,
      session,
      targetBranch,
      baseBranch = 'main',
      hardTimeoutMs = this.config.workflowHardTimeout,
      completionTimeoutMs = this.config.completionTimeout,
      maxHandoffs = Math.min(Math.ceil(this.config.goalBudget / 1_000_000), 20),
      contextHighTokens = this.config.contextThreshold,
      maxTotalTokens = this.config.goalBudget,
    } = options;

    const backlogId = options.backlogId;
    const iid = requestedIid ?? (Number.isSafeInteger(Number(backlogId)) ? Number(backlogId) : 0);
    let terminalOutcome: RunOutcomeStatus = 'failed';
    this.resourceScope = undefined;
    this.activeBacklog = undefined;
    this.activeClaim = undefined;
    this.leaseLost = false;
    this.runtimeRunId = undefined;
    this.runtimeErrorSummary = undefined;
    if (this.providers) {
      const claimed = await this.providers.backlog.claim(backlogId, session);
      if (!claimed) {
        logger.info({ backlogId }, 'backlog is not runnable or was claimed by another worker');
        return { success: false, skipped: 'not_claimed' };
      }
      this.activeBacklog = claimed.item;
      this.activeClaim = claimed;
      this.activeRework = await this.providers.backlog.getActiveRework(backlogId);
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
          options.claimHeartbeatIntervalMs ?? 30_000,
          async error => {
            this.leaseLost = true;
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
      if (!options.branchStrategy) options = { ...options, branchStrategy: { type: 'named', branch: claimed.item.branchName, baseBranch } };
    }

    const effectiveTemplate = options.template ?? 'issue-implementation';
    this.sandboxProviderName = options.sandboxProvider ?? 'local';
    this.agentProviderName = options.agentProvider ?? 'claude-code';
    this.executionMode = options.executionMode ?? 'batch';
    await this.startRuntime(options.backlogId, session);
    try {
    // Bind all git/worktree operations to the explicit project root. This
    // deliberately avoids process.chdir(), which is process-global state.
    this.repoRoot = options.repoRoot ?? process.cwd();
    this.systemActionsRan = false;
    this.primaryHandle = undefined;
    this.acFeedback = undefined;
    // Preserve injected WorktreeManager fakes and legacy cwd behavior when
    // no explicit project context was requested.

    // Resolve sandbox provider by name (CLI path).
    this.sandboxProvider = this.sandboxProviderByName(this.sandboxProviderName);

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

    // Validate template early so failures throw before worktree creation. A
    // claimed backlog must never be left in-progress when validation fails.
    await new TemplateLoader({ projectRoot: this.repoRoot }).load(effectiveTemplate);
    } catch (error) {
      this.runtimeErrorSummary = `workflow setup failed: ${(error as Error).message}`;
      await this.markBacklogBlocked(`workflow setup failed: ${(error as Error).message}`);
      await this.resourceScope?.finish({ status: 'failed' });
      await this.finishRuntime('blocked', 'workflow setup failed');
      throw error;
    }

    try {
      const result = await this.runBody({ iid, session, targetBranch, baseBranch, hardTimeoutMs, completionTimeoutMs, maxHandoffs, contextHighTokens, maxTotalTokens, projectName: options.projectName, repoRoot: this.repoRoot, branchStrategy: options.branchStrategy, template: effectiveTemplate, executionMode: this.executionMode });
      if (result.success && this.leaseLost) {
        await this.markBacklogBlocked('claim heartbeat failed');
        terminalOutcome = 'failed';
        return { success: false };
      }
      if (this.providers && this.activeBacklog) {
        await this.providers.backlog.transition(this.activeBacklog.id, result.success ? 'verification' : 'blocked', result.success ? undefined : { reason: 'workflow execution failed' });
        if (!result.success) await this.providers.backlog.setExecutionMode(this.activeBacklog.id, 'hitl');
      }
      terminalOutcome = result.success ? 'success' : 'failed';
      return result;
    } catch (error) {
      logger.error({ iid, err: error }, 'workflow runBody threw unexpectedly');
      this.runtimeErrorSummary = `workflow crashed: ${(error as Error).message}`;
      await this.cleanupOnFailure(iid, session);
      await this.markBacklogBlocked('workflow crashed');
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
   * Cleanup on unexpected crash: update GitHub issue first, then clean local
   * resources. This ensures issue status is updated even if the process
   * crashes afterward. Explicit failure paths (timeout / handoff / silent
   * stop) handle their own cleanup inside their handlers.
   */
  private async cleanupOnFailure(iid: number, session: string): Promise<void> {
    try {
      await this.transitionBacklog(iid, 'blocked', 'workflow crashed');
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

  private async resolveStepPrompt(step: Step, ctx?: StepRunCtx): Promise<string> {
    if (!step.prompt) throw new Error(`agent step '${step.id}' is missing prompt`);
    let prompt = typeof step.prompt === 'string' ? step.prompt : await fs.readFile(step.prompt.file, 'utf-8');
    // Variable substitution: {iid} → issue number
    if (ctx?.iid) {
      prompt = prompt.replaceAll('{iid}', String(ctx.iid));
    }
    if (this.activeBacklog) {
      const description = this.activeBacklog.description?.trim();
      prompt = `${prompt}\n\nBacklog title: ${this.activeBacklog.title}${description ? `\nBacklog description:\n${description}` : ''}`;
    }
    if (step.id === 'implement') {
      const rework = this.activeRework ? formatReworkContext(this.activeRework) : '';
      const acCorrection = this.acFeedback ? formatAcCorrection(this.acFeedback) : '';
      prompt = `${prompt}${rework}${acCorrection}`;
    }
    return prompt;
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
    const prompt = await this.resolveStepPrompt(step, ctx);
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

    // A local interactive session must own one workflow phase. Reusing the
    // implementation TUI for AC verification can submit the next prompt while
    // Claude is still returning from the previous one, losing that prompt.
    const needsDedicatedSandbox = ctx.executionMode === 'interactive' || branchHandle.path !== ctx.primaryWtPath;
    const sandbox = needsDedicatedSandbox
      ? await this.sandboxProvider.create({ worktreePath: branchHandle.path, session: ctx.session, branch: branchHandle.branch, tmux: this.tmux, executionMode: ctx.executionMode })
      : this.sandbox!;
    if (sandbox !== this.sandbox) {
      this.stepSandboxes.push(sandbox);
      this.resourceScope?.registerSandbox(sandbox);
    }
    await this.heartbeatRuntime({ worktree: branchHandle.path, branch: branchHandle.branch, progress: `running ${step.id}` });
    const completionKind: CompletionKind = step.id === 'verify-ac' ? 'ac' : 'task';
    let phase: PhaseResult;
    try {
      phase = await this.runPhase({
        iid: ctx.iid,
        session: ctx.session,
        wtPath: branchHandle.path,
        hardTimeoutMs: effectiveTimeout,
        completionTimeoutMs: ctx.completionTimeoutMs,
        contextHighTokens: ctx.contextHighTokens,
        budget: ctx.budget,
        prompt,
        signalType,
        executionMode: ctx.executionMode ?? 'batch',
        agentProvider: step.provider ? createAgentProvider(step.provider) : this.agentProvider,
        sandbox,
        completionKind,
      });
    } finally {
      if (sandbox !== this.sandbox && ctx.executionMode === 'interactive') await sandbox.close();
    }

    const completedAt = new Date().toISOString();
    const acFailure = completionKind === 'ac' ? parseAcVerificationFailure(phase.output) : undefined;
    const completed = completionKind === 'ac'
      ? phase.completed && isAcVerificationPass(phase.output)
      : phase.completed;
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
    baseBranch: string; hardTimeoutMs: number; completionTimeoutMs: number;
    maxHandoffs: number; contextHighTokens: number; maxTotalTokens: number;
    projectName?: string;
    repoRoot: string;
    branchStrategy?: unknown;
    template: string;
    executionMode?: ExecutionMode;
  }): Promise<{ success: boolean; url?: string }> {
    const { iid, session, targetBranch, baseBranch, hardTimeoutMs, completionTimeoutMs, maxHandoffs, contextHighTokens, maxTotalTokens, projectName, repoRoot, branchStrategy, template, executionMode } = ctx;

    // ── Step 0: Init hooks (pre-worktree) ─────────────────────────────────
    // ProjectResolverModule runs here and may chdir to the target repo.
    // Init failures throw — init is infrastructure, not opt-in.
    await this.runInitHooks({ iid, projectName, baseBranch, params: this.extParams, originalCwd: this.originalCwd, repoRoot });
    logger.info({ iid, projectName, baseBranch, moduleCount: this.modules.length }, 'init hooks complete');

    // ── Step 1: Create worktree ─────────────────────────────────────────────
    let wt: { iid: number; path: string; branch: string; createdAt: Date; status: 'active' };
    if (!this.activeBacklog) throw new Error('backlog is not active');
    const handle = await this.providers.branches.createBranch(this.activeBacklog, baseBranch);
    this.primaryHandle = { branch: handle.branchName, path: handle.worktreePath, isNewBranch: true };
    wt = { iid, path: handle.worktreePath, branch: handle.branchName, createdAt: new Date(), status: 'active' };
    logger.info({ iid, worktree: wt.path, branch: wt.branch }, 'worktree created');
    logger.info({ iid, status: 'active' }, 'worktree status updated');
    if (this.executionMode === 'interactive') {
      await configureStatusline(wt.path);
      logger.info({ iid, worktree: wt.path }, 'statusline configured');
    }

    // ── Step 1b: Lifecycle before_agent hooks ──────────────────────────────
    this.lifecycleCtx = { iid, worktreePath: wt.path, baseBranch, sessionName: session, params: this.extParams, repoRoot, projectName, originalCwd: this.originalCwd };
    await this.runLifecycleHooks(['before'], this.lifecycleCtx);
    logger.info({ iid, hook: 'before_agent', moduleCount: this.modules.length }, 'lifecycle before_agent hooks complete');

    // ── Step 2: Create sandbox (local: tmux session + prompt wait) ─────────
    this.sandbox = await this.sandboxProvider.create({
      worktreePath: wt.path,
      session,
      branch: targetBranch,
      tmux: this.tmux,
      executionMode: this.executionMode,
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
    const budget = new BudgetManager(maxHandoffs, maxTotalTokens);
    const stepResults: Record<string, StepResult> = {};

    // ── Template execution: compilation + typed dispatch ─────────────────────
    logger.info({ iid, template }, 'using compiled execution plan');
    const loadedTemplate = await new TemplateLoader({ projectRoot: repoRoot }).load(template);
    const autoWrapupOverridden = this.autoWrapup !== WorkflowRunner.prototype.autoWrapup;
    const systemActions = new SystemActionExecutor({
      publishChange: async () => {
        if (autoWrapupOverridden) return { url: undefined };
        await this.providers.branches.push(wt.branch, wt.path);
        this.systemActionsRan = true;
        return { url: undefined };
      },
      queueQA: async () => {
        if (autoWrapupOverridden) return { queued: true };
        await this.transitionBacklog(iid, 'verification');
        this.systemActionsRan = true;
        return { queued: true };
      },
      plugins: this.plugins,
    });
    const executor = new PlanExecutor({
      executeAgent: (step, results) => this.runStep(step, {
        iid, session: `${session}-${step.id}`, baseSession: session,
        primaryWtPath: wt.path, primaryBranch: wt.branch, baseBranch,
        hardTimeoutMs, completionTimeoutMs, contextHighTokens, budget, stepIndex: 0,
        executionMode: step.executionMode ?? executionMode,
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
        hardTimeoutMs, completionTimeoutMs, contextHighTokens, budget, executionMode,
      }, verification, stepResults);
      if (recovered) {
        await this.providers.branches.push(wt.branch, wt.path);
        await this.transitionBacklog(iid, 'verification');
        this.systemActionsRan = true;
      }
    }
    if (Object.values(stepResults).some(result => result.status === 'failed' || result.status === 'timed_out' || result.status === 'aborted')) {
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
      if (!this.primaryHandle) return;
      await this.providers.branches.cleanup(this.primaryHandle.path, { preserve: !force });
    } catch (error) {
      logger.warn({ iid, error }, 'failed to remove primary worktree');
    }
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
    // Push the implementation branch. QA creates the change request only
    // after merging the latest baseline and running integration tests.
    await this.pushBranch(worktreePath);
    logger.info({ iid, worktreePath }, 'branch pushed');

    if (this.leaseLost) {
      await this.markBacklogBlocked('claim heartbeat failed');
      return { success: false };
    }

    await this.transitionBacklog(iid, 'verification');

    await this.cleanupPrimary(iid, true);
    logger.info({ iid, worktreePath }, 'worktree cleaned up');

    return { success: true };
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
    timeoutMs: number
  ): Promise<void> {
    const snapshot = await this.tmux.capturePane(session, 'main', { lines: 100, history: 1000 });
    const logPath = `${this.logDir}/timeout-${iid}-${Date.now()}.log`;

    await fs.mkdir(this.logDir, { recursive: true });
    await fs.writeFile(logPath, snapshot, 'utf-8');

    try {
      await this.transitionBacklog(iid, 'blocked', 'workflow timeout');
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
    contextHighTokens: number;
    budget: BudgetManager;
    prompt: string;
    signalType: 'goal_complete';
    executionMode?: ExecutionMode;
    agentProvider?: AgentProvider;
    sandbox?: Sandbox;
    completionKind: CompletionKind;
  }): Promise<PhaseResult> {
    const basePrompt = p.prompt ?? (p as unknown as { goalBase?: string }).goalBase ?? '';
    for (let round = 1; ; round++) {
      const rawPrompt = round === 1
        ? basePrompt
        : this.continuePrompt(basePrompt, p.iid, p.wtPath, round - 1);
      const prompt = buildExecutionPrompt(rawPrompt, p.executionMode, p.completionKind);

      logger.info({ iid: p.iid, round, signalType: p.signalType, budgetUsed: p.budget.used }, 'round begin');

      const agentProvider = p.agentProvider ?? this.agentProvider;
      const sandbox = p.sandbox ?? this.sandbox!;
      const command = agentProvider.buildCommand({
        worktreePath: p.wtPath,
        sessionId: p.session,
        executionMode: p.executionMode,
      });
      let execution = await sandbox.startAgent({
        command,
        generation: p.budget.used + 1,
        prompt,
        signalType: p.signalType,
        executionMode: p.executionMode,
        agentProvider,
      });
      this.resourceScope?.registerExecution(execution);
      await this.heartbeatRuntime({ phase: 'implementing', progress: `agent generation ${round}` });
      logger.info({ iid: p.iid, round, signalType: p.signalType }, 'goal sent');

      let result = await execution.waitForResult({
        completionTimeoutMs: p.completionTimeoutMs,
        contextHighTokens: p.contextHighTokens,
      });
      await this.writeRuntimeDiagnostics(result, execution);

      switch (result.status) {
        case 'completed':
          return { completed: true, output: result.structuredOutput };

        case 'timed_out':
          await this.handleTimeout(p.iid, p.wtPath, p.session, p.hardTimeoutMs);
          return { completed: false };

        case 'context_high': {
          const hctx = {
            backlogId: this.activeBacklog?.id ?? String(p.iid),
            session: p.session,
            wtPath: p.wtPath,
            hardTimeoutMs: p.hardTimeoutMs,
            gen: p.budget.used + 1,
            tokens: result.usage?.totalTokens ?? 0,
          };

          if (p.budget.isExhausted(hctx.tokens)) {
            await this.coordinator.handoff(hctx, 'terminal', p.budget.exhaustionReason(hctx.tokens)!);
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

          // Phase 4 native resume: attemptNativeResume encapsulates the full
          // resume flow (capability check, load snapshot, restoreSession,
          // startAgent, waitForResult). On 'completed' return true; on 'continued'
          // reassign (execution, result) to the resumed values and loop back;
          // on 'failed' fall through to HandoffCoordinator.
          const resumeOutcome = await attemptNativeResume(
            {
              iid: p.iid,
              session: p.session,
              wtPath: p.wtPath,
              runId,
              generation: p.budget.used + 2,
              completionTimeoutMs: p.completionTimeoutMs,
              contextHighTokens: p.contextHighTokens,
              signalType: p.signalType,
              prompt,
              triggerTokens: hctx.tokens,
              executionMode: p.executionMode,
            },
            p.budget,
            agentProvider,
            sandbox,
            () => chain,
            () => execution.captureSession(),
          );

          if (resumeOutcome.status === 'completed') return { completed: true };
          if (resumeOutcome.status === 'continued') {
            execution = resumeOutcome.resumedExecution;
            this.resourceScope?.registerExecution(execution);
            result = resumeOutcome.resumeResult;
            logger.info({ iid: p.iid, runId }, 'native resume: agent hit context_high again; looping');
            continue;
          }
          // 'failed' — fall through to coordinator

          // Coordinator.restartSession() creates a new tmux session.
          // After it returns, the loop continues and sends the continued goal in the next iteration.
          // This mirrors the original behavior exactly.
          if ((await this.coordinator.handoff(hctx, 'auto')) === 'continued') {
            p.budget.record(hctx.tokens);
            logger.info({ iid: p.iid, round, generation: p.budget.used + 1 }, 'handoff continued; looping to send continued goal');
            continue;
          }
          return { completed: false }; // auto-handoff flipped to manual; phase over
        }

        default:
          // 'failed', 'blocked', 'aborted' — treat as failure
          const diagnostics = formatExecutionFailure(result);
          this.runtimeErrorSummary = diagnostics;
          logger.warn({ iid: p.iid, status: result.status, diagnostics }, 'execution returned non-success status');
          if (round === 1) {
            // Initial round failure: unchanged crash path
            throw new Error(`execution failed: ${diagnostics}`);
          }
          await this.manualFlip(p.iid, p.session);
          return { completed: false };
      }
    }
  }

  private async retryFailedAcVerification(
    template: import('../domain/templates/types').WorkflowTemplate,
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
      await this.providers.backlog.transition(this.activeBacklog.id, 'blocked', { reason });
      await this.providers.backlog.setExecutionMode(this.activeBacklog.id, 'hitl');
    } catch (error) {
      logger.warn({ backlogId: this.activeBacklog.id, error }, 'failed to mark backlog blocked');
    }
  }

  private async startRuntime(backlogId: string, session: string): Promise<void> {
    if (this.runtimeRunId) return;
    const now = new Date().toISOString();
    this.runtimeRunId = `${session}-${Date.now()}`;
    try {
      await this.runtimeManager.start({
        runId: this.runtimeRunId,
        backlogId,
        title: this.activeBacklog?.title,
        phase: 'implementing',
        status: 'running',
        sandboxProvider: this.sandboxProviderName,
        executionMode: this.executionMode,
        agentProvider: this.agentProviderName,
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
