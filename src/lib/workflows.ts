import { promises as fs } from 'fs';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import type { TrackerProvider, Platform } from './core/tracker/types';
import { TmuxClient, createTmuxClient } from './core/tmux';
import { WorktreeManager, createWorktreeManager } from './core/git';
import { createSandboxProvider } from './sandbox';
import { createAgentProvider } from './agents';
import type {
  Sandbox,
  SandboxProvider,
  SandboxProviderName,
  AgentExecution,
  ExecutionResult,
} from './sandbox/types';
import type { AgentProvider, AgentProviderName, SessionSnapshot } from './agents/types';
import type { BranchStrategyConfig } from './branches/types';
import { getTokenUsage, configureStatusline, logger, readSignal } from './io';
import { getWorkflowConfig } from './core/config/manager';
import { loadModules, parseModuleParams } from './modules/_registry';
import type { LifecycleModule, LifecycleContext } from './workflows/lifecycle';
import { Watchdog, createWatchdog } from './workflows/watchdog';
import { HandoffCoordinator, handoffDocPath, createHandoffCoordinator } from './workflows/handoff';
import { attemptNativeResume } from './workflows/resume';
import { BudgetManager } from './workflows/budget';
import type { InitContext } from './workflows/lifecycle';
import { defaultSessionStoreChain } from './sessions/chain';
import { planFor } from './templates/registry';
import { evaluateWhen } from './templates/when-evaluator';
import { strategyForConfig } from './branches/registry';
import type { Step, StepResult, TemplateBranchStrategyConfig } from './templates/types';
import type { ExecutionPlan, ExecutionGroup } from './templates/resolver';
import type { BranchHandle } from './branches/types';

/**
 * Signal-driven workflow runner.
 *
 * Two-phase design:
 *   Phase 1 (Implement): send /goal "实现 issue #N" -> wait goal_complete
 *   Phase 2 (Verify):   send /goal "验证 issue #N 的 AC" -> wait ac_result
 *   autoWrapup:         push branch -> create MR -> stage::qa
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
  iid: number;
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
  platform?: Platform;
  /** Target project (cross-project dispatch). Drives ProjectResolverModule. */
  projectName?: string;
  /** Module names to activate (e.g., ['isolate', 'mock-server']) */
  ext?: string[];
  /** Module parameters (e.g., ['isolate.auto=true']) */
  extParams?: string[];
  /** Sandbox provider name (default: 'local'). */
  sandboxProvider?: SandboxProviderName;
  /** Agent provider name (default: 'claude-code'). */
  agentProvider?: AgentProviderName;
  /** Branch strategy config for all steps (default: issue-based). */
  branchStrategy?: BranchStrategyConfig;
  /** Workflow template name to run instead of the default two-phase flow. */
  template?: string;
}

/**
 * Optional collaborator overrides for WorkflowRunner. Tests inject a fake
 * coordinator (and tmux) to exercise the phase loop's routing without a real
 * tmux / tracker / filesystem - the same factory pattern LoopRunner uses for
 * WorkflowRunner itself.
 */
export interface RunnerDependencies {
  coordinatorFactory?: (deps: {
    tracker: TrackerProvider;
    tmux: TmuxClient;
    watchdog: Watchdog;
  }) => HandoffCoordinator;
  /** Override the tmux client (tests). Defaults to a new TmuxClient. */
  tmux?: TmuxClient;
  /** Override the watchdog (tests). Defaults to a new Watchdog. */
  watchdog?: Watchdog;
  /** Sandbox provider (tests / future). Defaults to LocalSandboxProvider. */
  sandboxProvider?: SandboxProvider;
  /** Agent provider (tests). Defaults to ClaudeCodeProvider. */
  agentProvider?: import('./agents/types').AgentProvider;
  /** Session store chain (tests / future). Defaults to defaultSessionStoreChain. */
  sessionStoreChain?: (worktreePath: string) => import('./sessions/types').SessionStoreChain;
}

/**
 * Signal-driven workflow runner.
 *
 * Two-phase design:
 *   Phase 1 (Implement): send /goal "实现 issue #N" -> wait goal_complete
 *   Phase 2 (Verify):   send /goal "验证 issue #N 的 AC" -> wait ac_result
 *   autoWrapup:         push branch -> create MR -> stage::qa
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
}

export class WorkflowRunner {
  private tracker: TrackerProvider;
  private tmux: TmuxClient;
  private worktree: WorktreeManager;
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
  private sandbox: Sandbox | undefined;
  private logDir: string;
  private modules: LifecycleModule[] = [];
  private extParams: Record<string, unknown> = {};
  private originalCwd: string = '';
  private lifecycleCtx: LifecycleContext = { iid: 0, worktreePath: '', baseBranch: '', sessionName: '', params: {} };
  /** Branch handles created per step in template execution. Cleaned up in teardownSession. */
  private stepBranchHandles: BranchHandle[] = [];

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

  constructor(tracker: TrackerProvider, deps?: RunnerDependencies) {
    this.tracker = tracker;
    this.tmux = deps?.tmux ?? createTmuxClient();
    this.worktree = createWorktreeManager();
    this.logDir = `${process.env.HOME}/.claude/logs/afk`;
    this.watchdog = deps?.watchdog ?? createWatchdog(this.logDir);
    this.coordinator = deps?.coordinatorFactory
      ? deps.coordinatorFactory({ tracker, tmux: this.tmux, watchdog: this.watchdog })
      : createHandoffCoordinator({ tracker, tmux: this.tmux, watchdog: this.watchdog });
    this.sandboxProvider = deps?.sandboxProvider ?? createSandboxProvider('local', { worktreeManager: this.worktree });
    this.agentProvider = deps?.agentProvider ?? createAgentProvider(this.agentProviderName);
    // Default to the standard chain: FileSessionStore (native) -> HandoffSessionStore (Markdown fallback).
    this.sessionStoreChainFactory = deps?.sessionStoreChain ?? defaultSessionStoreChain;
  }

  /**
   * Full workflow: worktree -> tmux session -> /goal -> wait -> autoWrapup.
   * Every explicit terminal path does its own cleanup; the catch below only
   * covers unexpected exceptions (crash path), and the finally only ever
   * disarms the watchdog.
   */
  async run(options: RunnerOptions): Promise<{ success: boolean; url?: string }> {
    const {
      iid,
      session,
      targetBranch,
      baseBranch = 'main',
      hardTimeoutMs = getWorkflowConfig().workflowHardTimeout,
      completionTimeoutMs = getWorkflowConfig().completionTimeout,
      maxHandoffs = Math.min(Math.ceil(getWorkflowConfig().goalBudget / 1_000_000), 20),
      contextHighTokens = getWorkflowConfig().contextThreshold,
      maxTotalTokens = getWorkflowConfig().goalBudget,
    } = options;

    // Resolve sandbox provider by name (CLI path).
    this.sandboxProviderName = options.sandboxProvider ?? 'local';
    this.sandboxProvider = this.sandboxProviderByName(this.sandboxProviderName);

    // Resolve agent provider by name (CLI path). Agent registry must already have
    // the named provider registered (import side-effect or explicit registration).
    // Skip if constructor already injected one via deps (tests use this path).
    this.agentProviderName = options.agentProvider ?? 'claude-code';
    if (!this.agentProvider) {
      try {
        this.agentProvider = createAgentProvider(this.agentProviderName);
      } catch {
        // Agent not yet registered (e.g., test environment). Fall back to
        // claude-code; deps?.agentProvider already handled above.
        this.agentProvider = createAgentProvider('claude-code');
      }
    }

    // Load lifecycle modules
    this.modules = await loadModules(options.ext);
    this.extParams = parseModuleParams(options.extParams);
    this.originalCwd = process.cwd();
    logger.info({ iid, session, modules: this.modules.map(m => m.name), extParams: this.extParams, sandbox: this.sandboxProviderName, agent: this.agentProviderName }, 'WorkflowRunner initialized');

    // Validate template early so failures throw before worktree creation.
    if (options.template) planFor(options.template);

    try {
      return await this.runBody({ iid, session, targetBranch, baseBranch, hardTimeoutMs, completionTimeoutMs, maxHandoffs, contextHighTokens, maxTotalTokens, projectName: options.projectName, branchStrategy: options.branchStrategy, template: options.template });
    } catch (error) {
      logger.error({ iid, err: error }, 'workflow runBody threw unexpectedly');
      await this.cleanupOnFailure(iid, session);
      throw error;
    } finally {
      // Never leave an armed watchdog behind: it would fire later and write a
      // stale timeout signal into the retained worktree.
      this.watchdog.disarm();
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
      await this.tracker.addComment(iid, `<!-- afk-event: crashed -->
**💥 Workflow Failed**

Session was interrupted before completion.

**Recovery:** Remove \`mode::hitl\` label and re-trigger \`/afk-implement ${iid}\``);
      await this.tracker.addLabel(iid, 'mode::hitl');
      await this.tracker.removeLabel(iid, 'stage::afk-in-progress');
    } catch (err) {
      logger.error({ iid, err }, 'failed to update GitHub on cleanup');
    }

    await this.teardownSession(iid, session);
    // Lifecycle cleanup hooks (zeroed context - may run before runBody
    // populates lifecycleCtx; modules must be idempotent).
    await this.runLifecycleHooks(
      ['after', 'cleanup'],
      { iid: 0, worktreePath: '', baseBranch: '', sessionName: '', params: this.extParams },
      true,
    );
  }

  /**
   * Kill the tmux session, drop the control-mode connection, and mark the
   * worktree failed. Worktree itself is kept for inspection.
   */
  private async teardownSession(iid: number, session: string): Promise<void> {
    await this.sandbox?.close();
    try {
      await this.worktree.updateStatus(iid, 'failed');
    } catch (err) {
      logger.warn({ iid, err }, 'failed to mark worktree as failed');
    }
    // Cleanup all step worktrees created during template execution.
    for (const handle of this.stepBranchHandles) {
      try {
        const config: TemplateBranchStrategyConfig = { type: 'named', branch: handle.branch };
        const strategy = strategyForConfig(config);
        await strategy.cleanup(simpleGit(), config, handle, { force: true });
      } catch (err) {
        logger.warn({ handle }, 'failed to cleanup step worktree');
      }
    }
    this.stepBranchHandles = [];
  }

  // ── Template execution helpers ─────────────────────────────────────────────

  private async resolveStepPrompt(step: Step): Promise<string> {
    if (typeof step.prompt === 'string') return step.prompt;
    return await fs.readFile(step.prompt.file, 'utf-8');
  }

  private resolveStepSignalType(role: string): 'goal_complete' | 'ac_result' {
    const ROLE_TO_SIGNAL: Record<string, 'goal_complete' | 'ac_result'> = {
      implementer: 'goal_complete',
      verifier: 'ac_result',
      reviewer: 'goal_complete',
      planner: 'goal_complete',
      wrapup: 'goal_complete',
      qa: 'goal_complete',
      agent: 'goal_complete',
    };
    return ROLE_TO_SIGNAL[role] ?? 'goal_complete';
  }

  private async prepareStepWorktree(
    step: Step,
    iid: number,
    baseBranch: string,
  ): Promise<BranchHandle> {
    const config: TemplateBranchStrategyConfig = step.branch ?? { type: 'issue', iid };
    const strategy = strategyForConfig(config);
    return await strategy.prepareWorktree(simpleGit(), config, {
      repoPath: this.originalCwd,
      baseBranch,
      worktreeBaseDir: join(this.originalCwd, '.worktrees'),
    });
  }

  private async runStep(
    step: Step,
    ctx: StepRunCtx,
    stepResults: Record<string, StepResult>,
  ): Promise<StepResult> {
    const startedAt = new Date().toISOString();
    const goalBase = await this.resolveStepPrompt(step);
    const signalType = this.resolveStepSignalType(step.role);
    const effectiveTimeout = step.timeoutMs ?? ctx.hardTimeoutMs;

    // Determine worktree: reuse primary for step 0 in group 0, create new for concurrent or branched steps.
    let branchHandle: BranchHandle;
    if (ctx.stepIndex > 0 || step.branch != null) {
      branchHandle = await this.prepareStepWorktree(step, ctx.iid, ctx.baseBranch);
      this.stepBranchHandles.push(branchHandle);
    } else {
      branchHandle = { branch: ctx.primaryBranch, path: ctx.primaryWtPath, isNewBranch: false };
    }

    const completed = await this.runPhase({
      iid: ctx.iid,
      session: ctx.session,
      wtPath: branchHandle.path,
      hardTimeoutMs: effectiveTimeout,
      completionTimeoutMs: ctx.completionTimeoutMs,
      contextHighTokens: ctx.contextHighTokens,
      budget: ctx.budget,
      goalBase,
      signalType,
    });

    // Read summary from signal file (Phase 8 legacy fallback).
    let summary: string | undefined;
    try {
      const sig = await readSignal(branchHandle.path);
      if (sig && (sig.type === 'goal_complete' || sig.type === 'ac_result')) {
        summary = sig.summary;
      }
    } catch { /* ignore */ }

    const completedAt = new Date().toISOString();
    return {
      stepId: step.id,
      status: completed ? 'completed' : 'failed',
      summary,
      branch: branchHandle.branch,
      worktreePath: branchHandle.path,
      startedAt,
      completedAt,
    };
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
    branchStrategy?: BranchStrategyConfig;
    template?: string;
  }): Promise<{ success: boolean; url?: string }> {
    const { iid, session, targetBranch, baseBranch, hardTimeoutMs, completionTimeoutMs, maxHandoffs, contextHighTokens, maxTotalTokens, projectName, branchStrategy, template } = ctx;

    // ── Step 0: Init hooks (pre-worktree) ─────────────────────────────────
    // ProjectResolverModule runs here and may chdir to the target repo.
    // Init failures throw — init is infrastructure, not opt-in.
    await this.runInitHooks({ iid, projectName, baseBranch, params: this.extParams, originalCwd: this.originalCwd });
    logger.info({ iid, projectName, baseBranch, moduleCount: this.modules.length }, 'init hooks complete');

    // ── Step 1: Create worktree ─────────────────────────────────────────────
    const wt = await this.worktree.create(iid, baseBranch);
    logger.info({ iid, worktree: wt.path, branch: wt.branch }, 'worktree created');
    await this.worktree.updateStatus(iid, 'active');
    logger.info({ iid, status: 'active' }, 'worktree status updated');
    await configureStatusline(wt.path);
    logger.info({ iid, worktree: wt.path }, 'statusline configured');

    // ── Step 1b: Lifecycle before_agent hooks ──────────────────────────────
    this.lifecycleCtx = { iid, worktreePath: wt.path, baseBranch, sessionName: session, params: this.extParams };
    await this.runLifecycleHooks(['before'], this.lifecycleCtx);
    logger.info({ iid, hook: 'before_agent', moduleCount: this.modules.length }, 'lifecycle before_agent hooks complete');

    // ── Step 2: Create sandbox (local: tmux session + prompt wait) ─────────
    this.sandbox = await this.sandboxProvider.create({
      worktreePath: wt.path,
      session,
      branch: targetBranch,
      tmux: this.tmux,
    });
    logger.info({ iid, session, worktree: wt.path, sandboxId: this.sandbox.id }, 'sandbox created');

    // ── Step 3: Launch watchdog (detached, no blocking) ────────────────────
    this.watchdog.arm(session, hardTimeoutMs, iid, wt.path);
    logger.info({ iid, session, hardTimeoutMs }, 'watchdog armed');

    // ── Step 4: Post launch comment ────────────────────────────────────────
    await this.tracker.addComment(iid, [
      '<!-- afk-event: launch -->',
      '**🚀 AFK Session Started**',
      '',
      `- **Worktree:** \`${wt.path}\``,
      `- **Branch:** \`${targetBranch}\``,
      `- **Session:** \`${session}\``,
      `- **Issue:** #${iid}`,
    ].join('\n'));
    logger.info({ iid, event: 'launch' }, 'tracker comment posted');
    await this.tracker.addLabel(iid, `session::${session}`);
    logger.info({ iid, label: `session::${session}` }, 'tracker label added');
    await this.tracker.addLabel(iid, 'stage::afk-in-progress');
    logger.info({ iid, label: 'stage::afk-in-progress' }, 'tracker label added');
    await this.tracker.removeLabel(iid, 'stage::ready-for-issues');
    logger.info({ iid, label: 'stage::ready-for-issues' }, 'tracker label removed');

    // ── Phases: implement then verify; handoff budgets are shared across both ──
    // used = handoff rounds, tokens = accumulated total across generations.
    //
    // Phase 8: prompts no longer instruct the agent to write `.afk-signal.json`.
    // Completion is reported via ExecutionResult (structured output); old
    // worktrees that still write the signal file are still readable as a
    // fallback — see core/io/signal.ts.
    const budget = new BudgetManager(maxHandoffs, maxTotalTokens);
    const stepResults: Record<string, StepResult> = {};

    if (template) {
      // ── Template path: iterate ExecutionGroups ──────────────────────────────
      logger.info({ iid, template }, 'using execution plan');
      const plan = planFor(template);

      for (const group of plan.groups) {
        logger.info({ iid, level: group.level, stepCount: group.steps.length }, 'execution group begin');

        const runnableSteps = group.steps.filter(step => evaluateWhen(step.when, stepResults));
        if (runnableSteps.length === 0) {
          logger.info({ iid, level: group.level }, 'all steps gated off; skipping group');
          continue;
        }

        // Run all runnable steps in this group concurrently.
        const groupResults = await Promise.all(
          runnableSteps.map((step, idx) =>
            this.runStep(step, {
              iid, session: `${session}-${step.id}-${idx}`, baseSession: session,
              primaryWtPath: wt.path, primaryBranch: targetBranch,
              baseBranch, hardTimeoutMs, completionTimeoutMs,
              contextHighTokens, budget, stepIndex: idx,
            }, stepResults),
          ),
        );

        for (const r of groupResults) stepResults[r.stepId] = r;
        logger.info({ iid, level: group.level }, 'execution group end');

        const groupFailed = Object.values(groupResults).some(
          r => r.status === 'failed' || r.status === 'timed_out' || r.status === 'aborted',
        );
        if (groupFailed) {
          logger.warn({ iid, level: group.level }, 'group had failures; aborting workflow');
          return { success: false };
        }
      }
    } else {
      // ── Legacy path: hardcoded 2-phase behavior ────────────────────────────
      const phases = [
        { goalBase: `实现 issue #${iid} 的功能需求。请先执行 afk issue get ${iid} 查看 issue 详情、验收标准和 PRD 链接，然后根据需求实现功能。每完成一个 AC 就提交一次。`, signalType: 'goal_complete' as const },
        { goalBase: `验证 issue #${iid} 的 AC 全部通过。请先执行 afk issue get ${iid} 查看 issue 的验收标准，逐条验证代码是否实现了对应功能。如果发现 AC 未实现或实现不完整，请修复。`, signalType: 'ac_result' as const },
      ];

      for (const phase of phases) {
        logger.info({ iid, phase: phase.signalType === 'goal_complete' ? 'implement' : 'verify' }, 'phase begin');
        const completed = await this.runPhase({
          iid, session, wtPath: wt.path,
          hardTimeoutMs, completionTimeoutMs, contextHighTokens,
          budget,
          goalBase: phase.goalBase, signalType: phase.signalType,
        });
        logger.info({ iid, phase: phase.signalType === 'goal_complete' ? 'implement' : 'verify', completed }, 'phase end');
        if (!completed) return { success: false };
      }
    }

    // ── Lifecycle after_agent hooks (before cleanup) ────────────────────────
    await this.runLifecycleHooks(['after'], this.lifecycleCtx);
    logger.info({ iid, hook: 'after_agent', moduleCount: this.modules.length }, 'lifecycle after_agent hooks complete');

    // ac_result -> autoWrapup
    return this.autoWrapup(iid, wt.path, session, targetBranch);
  }

  /**
   * autoWrapup: push branch -> create MR -> stage::qa
   * AC verification is now done in Phase 2 of runBody, so this is a simple
   * push-and-MR operation.
   */
  private async autoWrapup(
    iid: number,
    worktreePath: string,
    session: string,
    targetBranch: string
  ): Promise<{ success: boolean; url?: string }> {
    // Push branch
    await this.pushBranch(worktreePath);
    logger.info({ iid, worktreePath }, 'branch pushed');

    // Create MR
    const mrUrl = await this.createMR(iid, worktreePath, targetBranch);
    logger.info({ iid, mrUrl }, 'MR created');

    // Session is no longer needed; sandbox.close() handles all session teardown.
    await this.sandbox!.close();
    logger.info({ iid, session }, 'sandbox closed');

    // Query MR/PR status and pipeline
    try {
      const mrId = this.extractMRIdFromUrl(mrUrl);
      if (mrId) {
        const mr = await this.tracker.getMR(mrId);
        logger.info({ iid, mrId, mrState: mr.state, pipeline: mr.pipeline?.status ?? 'N/A' }, 'MR status');
      }
    } catch (err) {
      logger.warn({ iid, err }, 'failed to query MR/PR status');
    }

    await this.tracker.addLabel(iid, 'stage::qa');
    logger.info({ iid, label: 'stage::qa' }, 'tracker label added');
    await this.tracker.removeLabel(iid, 'stage::afk-in-progress');
    logger.info({ iid, label: 'stage::afk-in-progress' }, 'tracker label removed');

    // Success path cleanup: sandbox already closed its control-mode connection;
    // remove the now-redundant worktree (force: stray untracked artifacts may exist).
    try {
      await this.worktree.cleanup(iid, true);
      logger.info({ iid, worktreePath }, 'worktree cleaned up');
    } catch (err) {
      logger.warn({ iid, err }, 'failed to remove worktree on success');
    }

    return { success: true, url: mrUrl };
  }

  /**
   * Extract MR/PR numeric ID from URL
   */
  private extractMRIdFromUrl(url: string): number | null {
    const match = url.match(/\/(merge_requests|pull)\/(\d+)/);
    return match ? parseInt(match[2], 10) : null;
  }

  /**
   * Handle hard timeout: capture session, post the recovery comment + labels,
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
      await this.tracker.addComment(iid, `<!-- afk-event: timeout -->
**⏱️ Hard Timeout**

Session exceeded ${Math.round(timeoutMs / 60000)}min and was force killed.

- **Log:** \`${logPath}\`

**Recovery:** Remove \`mode::hitl\` label and re-trigger \`/afk-implement ${iid}\``);
      await this.tracker.addLabel(iid, 'mode::hitl');
      await this.tracker.removeLabel(iid, 'stage::afk-in-progress');
    } catch (err) {
      logger.error({ iid, err }, 'failed to update GitHub on timeout');
    }

    await this.teardownSession(iid, session);
    // Lifecycle cleanup hooks (zeroed context, same as cleanupOnFailure).
    await this.runLifecycleHooks(
      ['after', 'cleanup'],
      { iid: 0, worktreePath: '', baseBranch: '', sessionName: '', params: this.extParams },
      true,
    );
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
    goalBase: string;
    signalType: 'goal_complete' | 'ac_result';
  }): Promise<boolean> {
    for (let round = 1; ; round++) {
      const goalText = round === 1
        ? p.goalBase
        : this.continueGoalText(p.goalBase, p.iid, p.wtPath, round - 1);

      logger.info({ iid: p.iid, round, signalType: p.signalType, budgetUsed: p.budget.used }, 'round begin');

      const command = this.agentProvider.buildCommand({
        worktreePath: p.wtPath,
        sessionId: p.session,
      });
      let execution = await this.sandbox!.startAgent({
        command,
        generation: p.budget.used + 1,
        goalText,
        signalType: p.signalType,
      });
      logger.info({ iid: p.iid, round, signalType: p.signalType }, 'goal sent');

      let result = await execution.waitForResult({
        completionTimeoutMs: p.completionTimeoutMs,
        contextHighTokens: p.contextHighTokens,
      });

      switch (result.status) {
        case 'completed':
          return true;

        case 'timed_out':
          await this.handleTimeout(p.iid, p.wtPath, p.session, p.hardTimeoutMs);
          return false;

        case 'context_high': {
          const hctx = {
            iid: p.iid,
            session: p.session,
            wtPath: p.wtPath,
            hardTimeoutMs: p.hardTimeoutMs,
            gen: p.budget.used + 1,
            tokens: result.usage?.totalTokens ?? 0,
          };

          if (p.budget.isExhausted(hctx.tokens)) {
            await this.coordinator.handoff(hctx, 'terminal', p.budget.exhaustionReason(hctx.tokens)!);
            return false;
          }

          // Phase 4 — save session snapshot to the store chain before handing off.
          // This allows future native-resume rounds to restore from the snapshot.
          // Errors are best-effort and do not affect the handoff flow.
          const chain = this.sessionStoreChainFactory(p.wtPath);
          const runId = `issue-${p.iid}-gen-${p.budget.used + 1}`;
          if (this.sandbox) {
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
              goalText,
              triggerTokens: hctx.tokens,
            },
            p.budget,
            this.agentProvider,
            this.sandbox!,
            () => chain,
            () => execution.captureSession(),
          );

          if (resumeOutcome.status === 'completed') return true;
          if (resumeOutcome.status === 'continued') {
            execution = resumeOutcome.resumedExecution;
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
          return false; // auto-handoff flipped to manual; phase over
        }

        default:
          // 'failed', 'blocked', 'aborted' — treat as failure
          logger.warn({ iid: p.iid, status: result.status }, 'execution returned non-success status');
          if (round === 1) {
            // Initial round failure: unchanged crash path
            throw new Error(`execution failed: ${result.status}`);
          }
          await this.manualFlip(p.iid, p.session);
          return false;
      }
    }
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

  /** Goal text for a resumed round: read the handoff doc(s) before continuing. */
  private continueGoalText(goalBase: string, iid: number, wtPath: string, gen: number): string {
    const docPath = handoffDocPath(wtPath, iid, gen);
    return `继续${goalBase}（上下文已交接，请先阅读交接文档 ${docPath}；若存在更早的交接文档（同目录 handoff-${iid}-*.md），请一并阅读以获取完整上下文，再继续）`;
  }

  /**
   * Mark the issue for manual resume and kill the session. Used when sendGoal
   * itself fails on a resumed round (a runner-level failure, distinct from the
   * coordinator's internal relaunch-failure flip).
   */
  private async manualFlip(iid: number, session: string): Promise<void> {
    await this.tracker
      .addLabel(iid, 'handoff::active')
      .catch(err => logger.warn({ iid, err }, 'failed to add handoff::active label'));
    await this.tmux.killSession(session).catch(() => { /* already dead */ });
    await this.tmux.closeSession();
  }

  /**
   * Push worktree branch to origin
   */
  private async pushBranch(worktreePath: string): Promise<void> {
    const git = simpleGit(worktreePath);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    await git.push('origin', branch, ['--set-upstream']);
  }

  /**
   * Create MR/PR via the tracker provider (GitHub: octokit PRs, GitLab: API).
   * Returns the MR/PR web URL for logging.
   */
  private async createMR(iid: number, worktreePath: string, targetBranch: string): Promise<string> {
    const git = simpleGit(worktreePath);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const issue = await this.tracker.getIssue(iid);

    const mrId = await this.tracker.createMR({
      title: `Draft: Resolve #${iid}`,
      description: `Closes #${iid}\n\n${issue.title}`,
      sourceBranch: branch,
      targetBranch,
      draft: true,
    });

    const mr = await this.tracker.getMR(mrId);
    return mr.url;
  }

}
