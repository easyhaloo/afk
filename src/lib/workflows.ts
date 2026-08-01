import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import type { TrackerProvider, Platform } from './core/tracker/types';
import { TmuxClient } from './tmux';
import { WorktreeManager } from './worktree';
import { getTokenUsage, configureStatusline, logger, readSignal, clearSignal, STATUS_FILENAME } from './io';
import { TIMEOUTS, CONTEXT, MAX_HANDOFFS, MAX_TOTAL_TOKENS } from './constants';
import { loadModules, parseModuleParams } from './modules/_registry';
import type { LifecycleModule } from './workflows/lifecycle';

/**
 * Detached spawn that works on both Linux and macOS.
 * `detached: true` + `stdio: 'ignore'` detaches from TTY on both platforms.
 * Returns the child so the caller can kill it (whole process group) later.
 */
function spawnDetached(file: string, args: string[], opts: SpawnOptions): ChildProcess {
  const child = spawn(file, args, { ...opts, stdio: 'ignore', detached: true } as SpawnOptions);
  child.unref();
  return child;
}

/** One phase wait: done / timeout / verified context overflow. */
type PhaseOutcome =
  | { kind: 'done' }
  | { kind: 'timeout' }
  | { kind: 'handoff'; tokens: number };

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
  /** Module names to activate (e.g., ['isolate', 'mock-server']) */
  ext?: string[];
  /** Module parameters (e.g., ['isolate.auto=true']) */
  extParams?: string[];
}

/**
 * Signal-driven workflow runner.
 *
 * Two-phase design:
 *   Phase 1 (Implement): send /goal "实现 issue #N" → wait goal_complete
 *   Phase 2 (Verify):   send /goal "验证 issue #N 的 AC" → wait ac_result
 *   autoWrapup:         push branch → create MR → stage::qa
 *
 * Each phase is a loop: send goal → poll for the completion signal OR the
 * context threshold (statusline token usage). On context_high the session is
 * interrupted, the agent's summary is captured to a doc + issue comment, and
 * the session is relaunched with the summary injected — until the phase
 * completes or the handoff budget runs out.
 *
 * Context detection is done by the RUNNER, not the agent: the agent cannot
 * reliably sense its own context limit (Claude Code's TUI warnings are
 * rendering-layer only, and the compaction system message arrives too late),
 * so we poll `<worktree>/.afk/claude-status.json` token usage (written by the
 * statusline tee on every turn) against `contextHighTokens`.
 *
 * Agent writes signals (`.afk-signal.json`): goal_complete / ac_result on
 * completion, timeout by the watchdog, handoff_ready during summary
 * negotiation. Context overflow is not a signal — the runner is the sole
 * authority, polling statusline token usage (objective data).
 *
 * Watchdog: detached setsid process fires after hardTimeoutMs — writes
 * a timeout signal to .afk-signal.json, then kills the tmux session.
 */
export class WorkflowRunner {
  private tracker: TrackerProvider;
  private tmux: TmuxClient;
  private worktree: WorktreeManager;
  private logDir: string;
  private modules: LifecycleModule[] = [];
  private extParams: Record<string, unknown> = {};

  constructor(tracker: TrackerProvider) {
    this.tracker = tracker;
    this.tmux = new TmuxClient();
    this.worktree = new WorktreeManager();
    this.logDir = `${process.env.HOME}/.claude/logs/afk`;
  }

  /**
   * Full workflow: worktree → tmux session → /goal → wait → autoWrapup.
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
      hardTimeoutMs = TIMEOUTS.WORKFLOW_HARD_TIMEOUT,
      completionTimeoutMs = TIMEOUTS.WORKFLOW_COMPLETION_TIMEOUT,
      maxHandoffs = MAX_HANDOFFS,
      contextHighTokens = CONTEXT.HIGH_THRESHOLD,
      maxTotalTokens = MAX_TOTAL_TOKENS,
    } = options;

    // Load lifecycle modules
    this.modules = await loadModules(options.ext);
    this.extParams = parseModuleParams(options.extParams);

    this._watchdog = null;

    try {
      return await this.runBody({ iid, session, targetBranch, baseBranch, hardTimeoutMs, completionTimeoutMs, maxHandoffs, contextHighTokens, maxTotalTokens });
    } catch (error) {
      logger.error({ iid, err: error }, 'workflow runBody threw unexpectedly');
      await this.cleanupOnFailure(iid, session);
      throw error;
    } finally {
      // Never leave an armed watchdog behind: it would fire later and write a
      // stale timeout signal into the retained worktree.
      this.killWatchdog();
    }
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
    // Lifecycle cleanup hooks
    await this.runLifecycleCleanup();
  }

  /**
   * Kill the tmux session, drop the control-mode connection, and mark the
   * worktree failed. Worktree itself is kept for inspection.
   */
  private async teardownSession(iid: number, session: string): Promise<void> {
    try {
      await this.tmux.killSession(session);
    } catch { /* ignore if session already gone */ }
    try {
      await this.tmux.closeSession();
    } catch { /* ignore */ }
    try {
      await this.worktree.updateStatus(iid, 'failed');
    } catch (err) {
      logger.warn({ iid, err }, 'failed to mark worktree as failed');
    }
  }

  /**
   * Run lifecycle cleanup hooks (after_agent + onCleanup) for all active modules.
   * Safe to call multiple times — modules are idempotent.
   */
  private async runLifecycleCleanup(): Promise<void> {
    // Run in reverse order (last loaded = first cleaned up)
    for (const mod of [...this.modules].reverse()) {
      try {
        await mod.onAfterAgent?.({
          iid: 0, worktreePath: '', baseBranch: '', sessionName: '',
          params: this.extParams,
        });
      } catch (err) {
        logger.warn({ module: mod.name, err }, 'lifecycle after_agent cleanup failed');
      }
      try {
        await mod.onCleanup?.({
          iid: 0, worktreePath: '', baseBranch: '', sessionName: '',
          params: this.extParams,
        });
      } catch (err) {
        logger.warn({ module: mod.name, err }, 'lifecycle onCleanup failed');
      }
    }
  }

  private async runBody(ctx: {
    iid: number; session: string; targetBranch: string;
    baseBranch: string; hardTimeoutMs: number; completionTimeoutMs: number;
    maxHandoffs: number; contextHighTokens: number; maxTotalTokens: number;
  }): Promise<{ success: boolean; url?: string }> {
    const { iid, session, targetBranch, baseBranch, hardTimeoutMs, completionTimeoutMs, maxHandoffs, contextHighTokens, maxTotalTokens } = ctx;

    // ── Step 1: Create worktree ─────────────────────────────────────────────
    const wt = await this.worktree.create(iid, baseBranch);
    await this.worktree.updateStatus(iid, 'active');
    await configureStatusline(wt.path);

    // ── Step 1b: Lifecycle before_agent hooks ──────────────────────────────
    const lifecycleCtx = {
      iid,
      worktreePath: wt.path,
      baseBranch,
      sessionName: session,
      params: this.extParams,
    };
    for (const mod of this.modules) {
      try {
        await mod.onBeforeAgent?.(lifecycleCtx);
      } catch (err) {
        logger.warn({ iid, module: mod.name, err }, 'lifecycle before_agent hook failed');
      }
    }

    // ── Step 2: Launch tmux session ─────────────────────────────────────────
    await this.tmux.createSession(session, wt.path);
    await this.tmux.waitForPrompt(wt.path, 30000);

    // ── Step 3: Launch watchdog (detached, no blocking) ────────────────────
    this.startWatchdog(session, hardTimeoutMs, iid, wt.path);

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
    await this.tracker.addLabel(iid, `session::${session}`);
    await this.tracker.addLabel(iid, 'stage::afk-in-progress');
    await this.tracker.removeLabel(iid, 'stage::ready-for-issues');

    // ── Phases: implement then verify; handoff budgets are shared across both ──
    // used = handoff rounds, tokens = accumulated total across generations.
    const budget = { used: 0, tokens: 0 };
    const phases = [
      { goalBase: `实现 issue #${iid} 的功能需求`, signalType: 'goal_complete' as const },
      { goalBase: `验证 issue #${iid} 的 AC 全部通过`, signalType: 'ac_result' as const },
    ];

    for (const phase of phases) {
      const completed = await this.runPhase({
        iid, session, wtPath: wt.path,
        hardTimeoutMs, completionTimeoutMs, contextHighTokens,
        budget, maxHandoffs, maxTotalTokens,
        goalBase: phase.goalBase, signalType: phase.signalType,
      });
      if (!completed) return { success: false };
    }

    // ── Lifecycle after_agent hooks (before cleanup) ────────────────────────
    for (const mod of this.modules) {
      try {
        await mod.onAfterAgent?.(lifecycleCtx);
      } catch (err) {
        logger.warn({ iid, module: mod.name, err }, 'lifecycle after_agent hook failed');
      }
    }

    // ac_result → autoWrapup
    return this.autoWrapup(iid, wt.path, session, targetBranch);
  }

  /**
   * autoWrapup: push branch → create MR → stage::qa
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

    // Create MR
    const mrUrl = await this.createMR(iid, worktreePath, targetBranch);

    // Session is no longer needed; kill it to avoid orphaned sessions.
    await this.tmux.killSession(session);

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
    await this.tracker.removeLabel(iid, 'stage::afk-in-progress');

    // Success path cleanup: drop the control-mode connection and remove the
    // now-redundant worktree (force: stray untracked artifacts may exist).
    try {
      await this.tmux.closeSession();
      await this.worktree.cleanup(iid, true);
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
   * terminal paths — it owns its own cleanup.
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
    // Lifecycle cleanup hooks
    await this.runLifecycleCleanup();
  }

  /** Armed hard-timeout watchdog (detached process group), if any. */
  private _watchdog: ChildProcess | null = null;

  /** Poll interval for waitForPhaseSignal (overridden by tests). */
  private pollIntervalMs = 2000;

  /**
   * Run one workflow phase (implement / verify) as a loop: send the goal,
   * wait for the completion signal or context overflow, and on verified
   * context_high kill + relaunch the session with the handoff summary
   * injected, until the phase completes or the handoff budget is exhausted.
   */
  private async runPhase(p: {
    iid: number;
    session: string;
    wtPath: string;
    hardTimeoutMs: number;
    completionTimeoutMs: number;
    contextHighTokens: number;
    maxHandoffs: number;
    maxTotalTokens: number;
    budget: { used: number; tokens: number };
    goalBase: string;
    signalType: 'goal_complete' | 'ac_result';
  }): Promise<boolean> {
    for (let round = 1; ; round++) {
      const goalText = round === 1
        ? p.goalBase
        : this.continueGoalText(p.goalBase, p.iid, p.wtPath, round - 1);

      try {
        await this.tmux.sendGoal(p.wtPath, p.session, 'main', goalText, p.signalType);
      } catch (err) {
        if (round === 1) throw err; // initial launch failure: unchanged crash path
        logger.error({ iid: p.iid, err, round }, 'continue-goal failed after handoff; flipping to manual handoff');
        await this.flipToManualHandoff(p.iid, p.session);
        return false;
      }

      const outcome = await this.waitForPhaseSignal({
        iid: p.iid,
        wtPath: p.wtPath,
        signalType: p.signalType,
        completionTimeoutMs: p.completionTimeoutMs,
        contextHighTokens: p.contextHighTokens,
      });

      switch (outcome.kind) {
        case 'done':
          return true;
        case 'timeout':
          await this.handleTimeout(p.iid, p.wtPath, p.session, p.hardTimeoutMs);
          return false;
        case 'handoff':
          if (p.budget.used >= p.maxHandoffs) {
            await this.terminalHandoff(p.iid, p.wtPath, p.session, outcome.tokens, 'budget');
            return false;
          }
          // Include the current session's usage: a relaunch would immediately
          // blow the remaining budget, so terminate instead.
          if (p.budget.tokens + outcome.tokens >= p.maxTotalTokens) {
            await this.terminalHandoff(p.iid, p.wtPath, p.session, outcome.tokens, 'tokens');
            return false;
          }
          if (await this.performHandoff({
            iid: p.iid, session: p.session, wtPath: p.wtPath,
            hardTimeoutMs: p.hardTimeoutMs,
            gen: p.budget.used + 1, tokens: outcome.tokens,
          })) {
            p.budget.used++;
            p.budget.tokens += outcome.tokens; // old session's usage is now sunk
            continue;
          }
          return false; // relaunch failed; flipped to manual handoff
      }
    }
  }

  /**
   * Poll for phase signals AND objective context overflow. The agent cannot
   * reliably detect its own context limit (TUI warnings are rendering-layer
   * only), so the runner polls the statusline token data directly.
   *
   * Each wait gets a full completionTimeoutMs budget (re-armed after a
   * handoff); the watchdog's hardTimeoutMs — also re-armed per generation —
   * is the real ceiling on total phase duration.
   */
  private async waitForPhaseSignal(p: {
    iid: number;
    wtPath: string;
    signalType: 'goal_complete' | 'ac_result';
    completionTimeoutMs: number;
    contextHighTokens: number;
  }): Promise<PhaseOutcome> {
    const start = Date.now();
    while (Date.now() - start < p.completionTimeoutMs) {
      // Signal file first: a completion signal wins over the token threshold.
      const signal = await readSignal(p.wtPath);
      if (signal?.type === p.signalType) return { kind: 'done' };
      if (signal?.type === 'timeout') return { kind: 'timeout' };

      // Objective poll: statusline token usage reached the threshold.
      const tokens = (await getTokenUsage(p.wtPath)).total;
      if (tokens >= p.contextHighTokens) {
        logger.info({ iid: p.iid, tokens, threshold: p.contextHighTokens }, 'context near limit; interrupting for handoff');
        return { kind: 'handoff', tokens };
      }

      await this.sleep(this.pollIntervalMs);
    }
    return { kind: 'timeout' };
  }

  /**
   * Negotiate the summary, persist it (doc + issue comment), then relaunch
   * the session. Returns true when relaunched, false when flipped to the
   * manual-resume protocol (recovery doc already posted).
   */
  private async performHandoff(p: {
    iid: number;
    session: string;
    wtPath: string;
    hardTimeoutMs: number;
    gen: number;
    tokens: number;
  }): Promise<boolean> {
    // Stop the hard budget during summary negotiation; the old watchdog's
    // timeout signal would clobber handoff_ready and kill the session mid-negotiation.
    this.killWatchdog();

    // Negotiate summary (throws → unchanged crash path).
    const info = await this.requestHandoffSummary(p.iid, p.session, p.wtPath);

    // Recovery doc in the worktree's .afk/handoff/ (gitignored, travels with the worktree).
    const { path: docPath } = await this.writeHandoffDoc(p.wtPath, p.iid, p.gen, info);

    // In-progress record; no handoff::active label in auto mode (that label is
    // the manual-resume marker). Best-effort: a comment failure must not abort.
    await this.tracker
      .addComment(p.iid, this.handoffComment({ ...info, iid: p.iid, tokens: p.tokens, gen: p.gen, docPath }))
      .catch(err => logger.warn({ iid: p.iid, err }, 'failed to post auto-handoff comment'));

    try {
      await this.restartSession(p);
      return true;
    } catch (err) {
      logger.error({ iid: p.iid, err, gen: p.gen }, 'auto-continue relaunch failed; flipping to manual handoff');
      await this.flipToManualHandoff(p.iid, p.session);
      return false;
    }
  }

  /**
   * Kill the session and start a fresh one with a new watchdog. The stale
   * control-mode connection, signal file, and statusline data must all be
   * cleared first — a stale connection reuses the session name and breaks
   * sendKeys, and stale data would make waitForPrompt return instantly and
   * getTokenUsage read the old session's tokens.
   */
  private async restartSession(p: {
    session: string;
    wtPath: string;
    hardTimeoutMs: number;
    iid: number;
  }): Promise<void> {
    await this.tmux.killSession(p.session).catch(() => { /* already dead */ });
    await this.tmux.closeSession();
    await clearSignal(p.wtPath); // a stale completion signal would end the next wait immediately
    await fs.rm(join(p.wtPath, '.afk', STATUS_FILENAME), { force: true }); // fresh session must not inherit old token data
    await this.tmux.createSession(p.session, p.wtPath);
    // waitForPrompt returns boolean, does NOT throw.
    if (!await this.tmux.waitForPrompt(p.wtPath, 30000)) {
      throw new Error(`relaunch: claude not ready within 30s (${p.wtPath})`);
    }
    this.startWatchdog(p.session, p.hardTimeoutMs, p.iid, p.wtPath); // fresh full hardTimeoutMs per generation
  }

  /**
   * Negotiate the handoff summary with the agent: type the request once
   * (plain text, not a slash command — /resume would open the session
   * picker), wait for handoff_ready, and fall back to the pane snapshot when
   * no summary arrives in time.
   */
  private async requestHandoffSummary(
    iid: number,
    session: string,
    worktreePath: string
  ): Promise<{ summary: string | null; snapshot: string; sha: string; branch: string }> {
    await this.typeHandoffRequest(session);

    const signal = await this.tmux.waitForSignal(session, 'main', 'handoff_ready', worktreePath, TIMEOUTS.HANDOFF_TIMEOUT);

    const snapshot = await this.tmux.capturePane(session, 'main', { lines: 100, history: 200 });
    const { sha, branch } = await this.gitHead(worktreePath);
    // The template placeholder is indistinguishable from "no summary".
    const summary = signal?.type === 'handoff_ready' && signal.summary !== '<总结>' ? signal.summary : null;
    return { summary, snapshot, sha, branch };
  }

  /** Type the plain-text handoff request (commit first, then 3 short questions, then signal template). */
  private async typeHandoffRequest(session: string): Promise<void> {
    const lines = [
      '上下文接近上限，AFK 需要交接。请立即完成以下操作，保持简短：',
      '0. 先提交：git add -A && git commit -m "handoff checkpoint"（无改动可跳过）',
      '1. 已完成的工作（一行）',
      '2. 正在做什么（一句话）',
      '3. 接下来做什么（一句话）',
      '完成后创建信号：cat > .afk-signal.json <<EOF',
      '{"type":"handoff_ready","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","summary":"<总结>"}',
      'EOF',
    ];
    for (const line of lines) {
      await this.tmux.sendKeys(session, 'main', line);
    }
  }

  /** Current HEAD sha + branch of the worktree (defensive: '(unknown)' when not a repo). */
  private async gitHead(worktreePath: string): Promise<{ sha: string; branch: string }> {
    try {
      const git = simpleGit(worktreePath);
      const [sha, branch] = await Promise.all([
        git.revparse('HEAD'),
        git.revparse(['--abbrev-ref', 'HEAD']),
      ]);
      return { sha, branch };
    } catch {
      return { sha: '(unknown)', branch: '(unknown)' };
    }
  }

  /**
   * Write the handoff recovery doc into the worktree's `.afk/handoff/`.
   * Safe from the agent's `git add -A` (`.afk/` is gitignored in the repo),
   * and it travels with the worktree — a resumed session reads it in place.
   */
  private async writeHandoffDoc(
    worktreePath: string,
    iid: number,
    gen: number | 'terminal',
    info: { summary: string | null; snapshot: string; sha: string; branch: string }
  ): Promise<{ path: string; content: string }> {
    const handoffDir = join(worktreePath, '.afk', 'handoff');
    await fs.mkdir(handoffDir, { recursive: true });
    const docPath = join(handoffDir, `handoff-${iid}-${gen}.md`);
    const content = [
      `# Handoff #${iid} (round ${gen})`,
      '',
      `- **Branch:** \`${info.branch}\``,
      `- **Commit:** \`${info.sha}\``,
      '',
      '## Summary',
      '',
      info.summary ?? '(agent did not provide a summary)',
      '',
      '## Session Snapshot (last 100 lines)',
      '',
      '```',
      info.snapshot,
      '```',
      '',
    ].join('\n');
    await fs.writeFile(docPath, content, 'utf-8');
    return { path: docPath, content };
  }

  /** Issue comment for an AUTO handoff round (in-progress record; terminal uses the full doc). */
  private handoffComment(p: {
    iid: number;
    tokens: number;
    gen: number;
    summary: string | null;
    snapshot: string;
    sha: string;
    branch: string;
    docPath: string;
  }): string {
    return [
      '<!-- afk-event: handoff -->',
      '**🔄 Context Handoff**',
      '',
      `- **Reason:** context_high (~${p.tokens} tokens)`,
      `- **Round:** ${p.gen}（自动继续中）`,
      `- **Branch:** \`${p.branch}\``,
      `- **Commit:** \`${p.sha}\``,
      `- **Handoff doc:** \`${p.docPath}\``,
      '',
      '### Summary',
      '',
      p.summary ?? '(agent did not provide a summary)',
      '',
      '<details>',
      '<summary>Session Snapshot (last 100 lines)</summary>',
      '',
      '```',
      p.snapshot,
      '```',
      '</details>',
    ].join('\n');
  }

  /** Goal text for a resumed round: read the handoff doc(s) before continuing. */
  private continueGoalText(goalBase: string, iid: number, wtPath: string, gen: number): string {
    const docPath = join(wtPath, '.afk', 'handoff', `handoff-${iid}-${gen}.md`);
    return `继续${goalBase}（上下文已交接，请先阅读交接文档 ${docPath}；若存在更早的交接文档（同目录 handoff-${iid}-*.md），请一并阅读以获取完整上下文，再继续）`;
  }

  /** Fall back to the manual-resume protocol: handoff::active label, session killed. */
  private async flipToManualHandoff(iid: number, session: string): Promise<void> {
    await this.tracker
      .addLabel(iid, 'handoff::active')
      .catch(err => logger.warn({ iid, err }, 'failed to add handoff::active label'));
    await this.tmux.killSession(session).catch(() => { /* already dead */ });
    await this.tmux.closeSession();
  }

  /**
   * Terminal handoff (handoff budget or total-token budget exhausted):
   * handoff::active label + recovery comment, session killed. The recovery
   * comment EMBEDS the full handoff doc (no file-path reference) — the
   * resume path reads everything from the issue. The worktree (with the doc
   * on disk) is retained for manual resume.
   */
  private async terminalHandoff(
    iid: number,
    worktreePath: string,
    session: string,
    tokens: number,
    reason: 'budget' | 'tokens'
  ): Promise<void> {
    this.killWatchdog(); // stale watchdog must not later write a timeout signal into the retained worktree
    const info = await this.requestHandoffSummary(iid, session, worktreePath);
    const doc = await this.writeHandoffDoc(worktreePath, iid, 'terminal', info);
    const reasonText = reason === 'budget' ? '已达最大交接轮数' : '已达总 token 上限';
    await this.tracker.addLabel(iid, 'handoff::active');
    await this.tracker.addComment(iid, [
      '<!-- afk-event: handoff -->',
      `**🔄 Context Handoff（终止：${reasonText}）**`,
      '',
      doc.content,
      '',
      `**To resume:** Remove \`handoff::active\` label and re-trigger \`/afk-implement ${iid}\``,
    ].join('\n'));
    await this.tmux.killSession(session).catch(() => {});
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

  /**
   * Start hard-timeout watchdog as detached process.
   * Fires after hardTimeoutMs: writes timeout signal then kills the tmux session,
   * so the WorkflowRunner's main loop can pick up the signal via file polling
   * rather than relying on tmux exit codes.
   */
  private startWatchdog(session: string, hardTimeoutMs: number, iid: number, worktreePath: string): void {
    const signalPath = `${worktreePath}/.afk-signal.json`;
    const shellCmd =
      `sleep ${hardTimeoutMs / 1000} && ` +
      `cat > "${signalPath}.tmp" <<EOF\n` +
      `{"type":"timeout","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}\n` +
      `EOF\n` +
      `mv "${signalPath}.tmp" "${signalPath}" 2>/dev/null; ` +
      `tmux kill-session -t "${session}" 2>/dev/null || true; ` +
      `echo "WATCHDOG:${iid}:${session}:${hardTimeoutMs}" >> "${this.logDir}/watchdog.log"`;
    this._watchdog = spawnDetached('bash', ['-c', shellCmd], { cwd: process.cwd() });
  }

  /**
   * Kill the armed watchdog. `detached: true` makes the child a process-group
   * leader, so the negative pid targets the whole group including the sleep
   * child — otherwise the sleep would survive and the chain would still fire.
   */
  private killWatchdog(): void {
    if (this._watchdog?.pid) {
      try {
        process.kill(-this._watchdog.pid, 'SIGTERM');
      } catch { /* already exited */ }
      this._watchdog = null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
