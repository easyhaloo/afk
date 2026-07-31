import { spawn } from 'child_process';
import type { ChildProcess, SpawnOptions } from 'child_process';

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
import type { TrackerProvider, Platform } from './core/tracker/types';
import { TmuxClient } from './tmux';
import { WorktreeManager } from './worktree';
import { getTokenUsage, configureStatusline, logger, readSignal, clearSignal, STATUS_FILENAME } from './io';
import type { Signal } from './schemas';
import { TIMEOUTS, CONTEXT, MAX_HANDOFFS } from './constants';

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
  platform?: Platform;
}

interface LaunchResult {
  worktreePath: string;
  session: string;
}

/**
 * Signal-driven workflow runner.
 *
 * Two-phase design:
 *   Phase 1 (Implement): send /goal "实现 issue #N" → wait goal_complete
 *   Phase 2 (Verify):   send /goal "验证 issue #N 的 AC" → wait ac_result
 *   autoWrapup:         push branch → create MR → stage::qa
 *
 * Agent is responsible for fetching the issue content and AC via gh/API.
 * WorkflowRunner only orchestrates: launch → wait signals → wrapup.
 *
 * Agent responsibilities (via skill instructions):
 *   - On goal complete: write goal_complete signal
 *   - On AC done:       write ac_result signal
 *   - On context high:  write context_high signal (Runner verifies
 *                        statusline JSON tokens ≥ CONTEXT.HIGH_THRESHOLD)
 *   - On handoff ready: write handoff_ready signal (Runner waits for it
 *                        then kills session)
 *
 * Watchdog: detached setsid process fires after hardTimeoutMs — writes
 * a timeout signal to .afk-signal.json, then kills the tmux session.
 */
export class WorkflowRunner {
  private tracker: TrackerProvider;
  private tmux: TmuxClient;
  private worktree: WorktreeManager;
  private logDir: string;

  constructor(tracker: TrackerProvider) {
    this.tracker = tracker;
    this.tmux = new TmuxClient();
    this.worktree = new WorktreeManager();
    this.logDir = `${process.env.HOME}/.claude/logs/afk`;
  }

  /**
   * Full workflow: worktree → tmux session → /goal → wait → autoWrapup
   */
  async run(options: RunnerOptions): Promise<{ success: boolean; url?: string }> {
    const {
      iid,
      session,
      targetBranch,
      baseBranch = 'main',
      maxRetries = 3,
      hardTimeoutMs = TIMEOUTS.WORKFLOW_HARD_TIMEOUT,
      completionTimeoutMs = TIMEOUTS.WORKFLOW_COMPLETION_TIMEOUT,
      maxHandoffs = MAX_HANDOFFS,
      contextHighTokens = CONTEXT.HIGH_THRESHOLD,
    } = options;

    // Reset cleanup state for this run
    this._cleanupType = 'none';
    this._lastTimeoutInfo = undefined;
    this._watchdog = null;

    let runResult: { success: boolean; url?: string } | undefined;

    try {
      runResult = await this.runBody(options, {
        iid, session, targetBranch, baseBranch,
        maxRetries, hardTimeoutMs, completionTimeoutMs,
        maxHandoffs, contextHighTokens,
      });
      return runResult;
    } catch (error) {
      logger.error({ iid, error: (error as Error).message }, 'workflow runBody threw unexpectedly');
      runResult = { success: false };
      throw error;
    } finally {
      // Never leave an armed watchdog behind: it would fire later and write a
      // stale timeout signal into the retained worktree.
      this.killWatchdog();
      // 'success' => handler (handoff) already cleaned up; skip. Otherwise run cleanup.
      // Cast to the declared union: runBody may set _cleanupType to 'success' via
      // the terminal handoff, which TS's narrowing from the reset above cannot track.
      const cleanupType = this._cleanupType as 'none' | 'context_low' | 'success';
      if (cleanupType !== 'success') {
        if (!runResult?.success) {
          await this.cleanupOnFailure(iid, session);
        } else {
          // Success: branch pushed + MR created in autoWrapup. Close tmux and remove
          // the now-redundant worktree (force: stray untracked artifacts may exist).
          await this.tmux.closeSession();
          try {
            await this.worktree.cleanup(iid, true);
          } catch (err) {
            logger.warn({ iid, err: (err as Error).message }, 'failed to remove worktree on success');
          }
        }
      }
    }
  }

  // Track which cleanup handler ran (to avoid double cleanup in finally)
  private _cleanupType: 'none' | 'context_low' | 'success' = 'none';

  /**
   * Cleanup on failure: update GitHub issue first, then clean local resources.
   * This ensures issue status is updated even if process crashes afterward.
   * Silent (no issue update) for graceful context_low stops.
   */
  private async cleanupOnFailure(iid: number, session: string): Promise<void> {
    try {
      // Step 1: Update GitHub issue (comment + labels).
      // Skipped for context_low (below-threshold context_high false alarm): graceful stop.
      if (this._cleanupType !== 'context_low') {
        if (this._lastTimeoutInfo?.iid === iid) {
          // Timeout case: use the pre-recorded timeout info
          await this.tracker.addComment(iid, `<!-- afk-event: timeout -->
**⏱️ Hard Timeout**

Session exceeded ${Math.round(this._lastTimeoutInfo.timeoutMs / 60000)}min and was force killed.

- **Log:** \`${this._lastTimeoutInfo.logPath}\`

**Recovery:** Remove \`mode::hitl\` label and re-trigger \`/afk-implement ${iid}\``);
          this._lastTimeoutInfo = undefined;
        } else {
          // Unexpected crash case
          await this.tracker.addComment(iid, `<!-- afk-event: crashed -->
**💥 Workflow Failed**

Session was interrupted before completion.

**Recovery:** Remove \`mode::hitl\` label and re-trigger \`/afk-implement ${iid}\``);
        }
        await this.tracker.addLabel(iid, 'mode::hitl');
        await this.tracker.removeLabel(iid, 'stage::afk-in-progress');
      }
    } catch (err) {
      logger.error({ iid, error: (err as Error).message }, 'failed to update GitHub on cleanup');
    }

    // Step 2: Cleanup local resources (worktree kept on failure for inspection)
    try {
      await this.tmux.killSession(session);
    } catch { /* ignore if session already gone */ }
    try {
      await this.tmux.closeSession();
    } catch { /* ignore */ }
    try {
      await this.worktree.updateStatus(iid, 'failed');
    } catch (err) {
      logger.warn({ iid, err: (err as Error).message }, 'failed to mark worktree as failed');
    }
  }

  private async runBody(
    options: RunnerOptions,
    ctx: {
      iid: number; session: string; targetBranch: string;
      baseBranch: string; maxRetries: number;
      hardTimeoutMs: number; completionTimeoutMs: number;
      maxHandoffs: number; contextHighTokens: number;
    }
  ): Promise<{ success: boolean; url?: string }> {
    const { iid, session, targetBranch, baseBranch, maxRetries, hardTimeoutMs, completionTimeoutMs, maxHandoffs, contextHighTokens } = ctx;

    // ── Step 1: Create worktree ─────────────────────────────────────────────
    const wt = await this.worktree.create(iid, baseBranch);
    await this.worktree.updateStatus(iid, 'active');
    await configureStatusline(wt.path);

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

    // ── Phase 1 — Implement (loop; auto-continue after context handoff) ───
    const handoff = { done: 0, remaining: maxHandoffs };
    const phase1 = await this.runPhase({
      iid, session, wtPath: wt.path,
      hardTimeoutMs, completionTimeoutMs,
      handoff, contextHighTokens,
      goalBase: `实现 issue #${iid} 的功能需求`,
      signalType: 'goal_complete',
      waitTypes: ['goal_complete', 'timeout', 'context_high'],
    });
    if (!phase1.completed) return phase1.result;

    // ── Phase 2 — Verify AC (loop; auto-continue after context handoff) ───
    const phase2 = await this.runPhase({
      iid, session, wtPath: wt.path,
      hardTimeoutMs, completionTimeoutMs,
      handoff, contextHighTokens,
      goalBase: `验证 issue #${iid} 的 AC 全部通过`,
      signalType: 'ac_result',
      waitTypes: ['ac_result', 'timeout', 'context_high'],
    });
    if (!phase2.completed) return phase2.result;

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
      logger.warn({ iid, err: (err as Error).message }, 'failed to query MR/PR status');
    }

    await this.tracker.addLabel(iid, 'stage::qa');
    await this.tracker.removeLabel(iid, 'stage::afk-in-progress');

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
   * Handle hard timeout: capture session, log to file, return failure result.
   * GitHub update and local cleanup are handled by run()'s finally block.
   */
  private async handleTimeout(
    iid: number,
    worktreePath: string,
    session: string,
    timeoutMs: number
  ): Promise<{ success: boolean }> {
    const snapshot = await this.tmux.capturePane(session, 'main', { lines: 100, history: 1000 });
    const logPath = `${this.logDir}/timeout-${iid}-${Date.now()}.log`;

    await (await import('fs')).promises.mkdir(this.logDir, { recursive: true });
    await (await import('fs')).promises.writeFile(logPath, snapshot, 'utf-8');

    // Store timeout info for cleanupOnFailure to post to GitHub.
    // Don't set _cleanupType: finally must run cleanupOnFailure (timeout branch)
    // to post the comment + labels. _lastTimeoutInfo selects the timeout branch.
    this._lastTimeoutInfo = { iid, timeoutMs, logPath };

    return { success: false };
  }

  private _lastTimeoutInfo?: { iid: number; timeoutMs: number; logPath: string };

  /** Armed hard-timeout watchdog (detached process group), if any. */
  private _watchdog: ChildProcess | null = null;

  /** Poll interval for waitForPhaseSignal (overridden by tests). */
  private pollIntervalMs = 2000;

  /**
   * Verify context_high objectively against the configured token threshold.
   * Returns 'below-threshold' (silent graceful stop) or the verified token count.
   */
  private async checkContextHigh(
    iid: number,
    worktreePath: string,
    threshold: number
  ): Promise<'below-threshold' | { tokens: number }> {
    const usage = await getTokenUsage(worktreePath);

    if (usage.total === 0) {
      logger.warn({ iid }, 'context_high detected but no token data; treating as below threshold');
      this._cleanupType = 'context_low';
      return 'below-threshold';
    }

    if (usage.total < threshold) {
      logger.info(
        { iid, tokens: usage.total, threshold },
        'context_high signal ignored: below threshold'
      );
      this._cleanupType = 'context_low';
      return 'below-threshold';
    }

    logger.info(
      { iid, tokens: usage.total, threshold },
      'context_high verified; triggering handoff'
    );
    return { tokens: usage.total };
  }

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
    handoff: { done: number; remaining: number };
    contextHighTokens: number;
    goalBase: string;
    signalType: 'goal_complete' | 'ac_result';
    waitTypes: Signal['type'][];
  }): Promise<{ completed: true } | { completed: false; result: { success: boolean } }> {
    let round = 0;

    while (true) {
      round++;
      const goalText = round === 1
        ? p.goalBase
        : this.continueGoalText(p.goalBase, p.iid, round - 1);

      try {
        await this.tmux.sendGoal(p.wtPath, p.session, 'main', goalText, p.signalType);
      } catch (err) {
        if (round === 1) throw err; // initial launch failure: unchanged crash path
        logger.error({ iid: p.iid, err: (err as Error).message, round }, 'continue-goal failed after handoff; flipping to manual handoff');
        await this.flipToManualHandoff(p.iid, p.session);
        return { completed: false, result: { success: false } };
      }

      const signal = await this.waitForPhaseSignal({
        iid: p.iid,
        wtPath: p.wtPath,
        waitTypes: p.waitTypes,
        completionTimeoutMs: p.completionTimeoutMs,
        contextHighTokens: p.contextHighTokens,
      });

      if (!signal || signal.type === 'timeout') {
        return { completed: false, result: await this.handleTimeout(p.iid, p.wtPath, p.session, p.hardTimeoutMs) };
      }
      if (signal.type !== 'context_high') {
        return { completed: true };
      }

      // context_high: verify objectively, then auto-relaunch or terminate.
      const verdict = await this.checkContextHigh(p.iid, p.wtPath, p.contextHighTokens);
      if (verdict === 'below-threshold') {
        // Silent graceful stop; cleanupOnFailure skips GitHub updates (_cleanupType='context_low').
        return { completed: false, result: { success: false } };
      }

      if (p.handoff.remaining > 0) {
        const outcome = await this.autoHandoffContinue({
          iid: p.iid,
          session: p.session,
          wtPath: p.wtPath,
          hardTimeoutMs: p.hardTimeoutMs,
          gen: p.handoff.done + 1,
          tokens: verdict.tokens,
        });
        if (outcome === 'relaunched') {
          p.handoff.done++;
          p.handoff.remaining--;
          logger.info({ iid: p.iid, round, handoffDone: p.handoff.done, budgetLeft: p.handoff.remaining }, 'context handoff done; continuing phase');
          continue;
        }
        return { completed: false, result: { success: false } }; // flipped to manual handoff
      }

      return { completed: false, result: await this.terminalHandoff(p.iid, p.wtPath, p.session, verdict.tokens) };
    }
  }

  /**
   * Poll for phase signals AND objective context overflow. Returns the first
   * matching signal, or a synthetic context_high when the statusline token
   * usage reaches the configured threshold. The agent cannot reliably detect
   * its own context limit (TUI warnings are not visible in the conversation),
   * so the runner polls the statusline data directly.
   */
  private async waitForPhaseSignal(p: {
    iid: number;
    wtPath: string;
    waitTypes: Signal['type'][];
    completionTimeoutMs: number;
    contextHighTokens: number;
  }): Promise<Signal | null> {
    const start = Date.now();
    while (Date.now() - start < p.completionTimeoutMs) {
      // Signal file first: if the agent already wrote a completion signal,
      // finish the phase instead of interrupting. A schema-invalid signal
      // (e.g. a foreign or mid-write file) is treated as no signal — the
      // poll must never crash the workflow over a stray file.
      let signal: Signal | null = null;
      try {
        signal = await readSignal(p.wtPath);
      } catch { /* malformed signal file: ignore and keep polling */ }
      if (signal && p.waitTypes.includes(signal.type)) return signal;

      const usage = await getTokenUsage(p.wtPath);
      if (usage.total >= p.contextHighTokens) {
        logger.info({ iid: p.iid, tokens: usage.total, threshold: p.contextHighTokens }, 'context near limit; interrupting for handoff');
        return { type: 'context_high', timestamp: new Date().toISOString() } as Signal;
      }

      await this.sleep(this.pollIntervalMs);
    }
    return null;
  }

  /**
   * Auto handoff: stop the hard budget, negotiate a summary with the agent,
   * write the recovery doc (outside the worktree), post the recovery comment,
   * then kill + relaunch the session with a fresh watchdog and continue.
   */
  private async autoHandoffContinue(p: {
    iid: number;
    session: string;
    wtPath: string;
    hardTimeoutMs: number;
    gen: number;
    tokens: number;
  }): Promise<'relaunched' | 'flipped'> {
    // Stop the hard budget during summary negotiation; the old watchdog's
    // timeout signal would clobber handoff_ready and kill the session mid-negotiation.
    this.killWatchdog();

    // Negotiate summary (throws → unchanged crash path).
    const info = await this.requestHandoffSummary(p.iid, p.session, p.wtPath);

    // Recovery doc OUTSIDE the worktree (never committed into the MR).
    const docPath = await this.writeHandoffDoc(p.iid, p.gen, info);

    // Recovery comment; no handoff::active label in auto mode (that label is
    // the manual-resume marker). Best-effort: a comment failure must not abort.
    await this.tracker
      .addComment(p.iid, this.handoffComment({ ...info, iid: p.iid, tokens: p.tokens, gen: p.gen, docPath, auto: true }))
      .catch(err => logger.warn({ iid: p.iid, err: (err as Error).message }, 'failed to post auto-handoff comment'));

    // Teardown + fresh session. Anything thrown from here on is caught and
    // flipped to manual — the recovery doc already exists.
    try {
      await this.tmux.killSession(p.session).catch(() => { /* already dead */ });
      await this.tmux.closeSession(); // must drop the stale control-mode connection (sendKeys reuses it by session name)
      await clearSignal(p.wtPath);    // stale context_high/handoff_ready would re-trigger the next wait immediately
      const fs = (await import('fs')).promises;
      const { join } = await import('path');
      // Fresh session must not see the old session's status data: waitForPrompt
      // only checks file existence, and getTokenUsage would read stale tokens.
      await fs.rm(join(p.wtPath, '.afk', STATUS_FILENAME), { force: true });
      await this.tmux.createSession(p.session, p.wtPath);
      const ready = await this.tmux.waitForPrompt(p.wtPath, 30000); // returns boolean, does NOT throw
      if (!ready) throw new Error(`relaunch: claude not ready within 30s (${p.wtPath})`);
      this.startWatchdog(p.session, p.hardTimeoutMs, p.iid, p.wtPath); // fresh full hardTimeoutMs per generation
      return 'relaunched';
    } catch (err) {
      logger.error({ iid: p.iid, err: (err as Error).message, gen: p.gen }, 'auto-continue relaunch failed; flipping to manual handoff');
      await this.flipToManualHandoff(p.iid, p.session);
      return 'flipped';
    }
  }

  /**
   * Negotiate the handoff summary with the agent: type the request (plain
   * text, not a slash command — /resume would open the session picker),
   * wait for handoff_ready; on timeout hard-interrupt with C-c and retry once.
   * Falls back to the pane snapshot when no summary is produced.
   */
  private async requestHandoffSummary(
    iid: number,
    session: string,
    worktreePath: string
  ): Promise<{ summary: string | null; snapshot: string; sha: string; branch: string }> {
    await this.typeHandoffRequest(session);

    let signal = await this.tmux.waitForSignal(session, 'main', 'handoff_ready', worktreePath, TIMEOUTS.HANDOFF_TIMEOUT);

    if (!signal) {
      // Hard-interrupt: cancel the running turn, then retry the request once.
      logger.warn({ iid }, 'no handoff_ready within timeout; sending C-c and retrying handoff request');
      await this.tmux.interrupt(session, 'main');
      await this.sleep(1500);
      await this.typeHandoffRequest(session);
      signal = await this.tmux.waitForSignal(session, 'main', 'handoff_ready', worktreePath, TIMEOUTS.HANDOFF_TIMEOUT);
    }

    const snapshot = await this.tmux.capturePane(session, 'main', { lines: 100, history: 200 });
    const { sha, branch } = await this.gitHead(worktreePath);
    return {
      summary: signal?.type === 'handoff_ready' ? signal.summary : null,
      snapshot,
      sha,
      branch,
    };
  }

  /** Type the plain-text handoff request (commit first, then 3 questions, then signal template). */
  private async typeHandoffRequest(session: string): Promise<void> {
    await this.tmux.sendKeys(session, 'main', '上下文接近上限，AFK 需要交接，请按以下步骤操作：');
    await this.tmux.sendKeys(session, 'main', '0. 请先提交当前更改：git add -A && git commit -m "handoff checkpoint"（如无改动可跳过）');
    await this.tmux.sendKeys(session, 'main', '1. 已完成的工作（简要列表）');
    await this.tmux.sendKeys(session, 'main', '2. 当前正在做什么');
    await this.tmux.sendKeys(session, 'main', '3. 接下来需要做什么');
    await this.tmux.sendKeys(session, 'main', '完成后创建信号：cat > .afk-signal.json <<EOF');
    await this.tmux.sendKeys(session, 'main', '{"type":"handoff_ready","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","summary":"<总结>"}');
    await this.tmux.sendKeys(session, 'main', 'EOF');
    await this.tmux.sendKeys(session, 'main', '（或直接回复：HANDOFF_READY）');
  }

  /** Current HEAD sha + branch of the worktree (defensive: '(unknown)' when not a repo). */
  private async gitHead(worktreePath: string): Promise<{ sha: string; branch: string }> {
    try {
      const git = (await import('simple-git')).simpleGit(worktreePath);
      const [sha, branch] = await Promise.all([
        git.revparse('HEAD'),
        git.revparse(['--abbrev-ref', 'HEAD']),
      ]);
      return { sha, branch };
    } catch {
      return { sha: '(unknown)', branch: '(unknown)' };
    }
  }

  /** Write the handoff recovery doc OUTSIDE the worktree (never committed into the MR). */
  private async writeHandoffDoc(
    iid: number,
    gen: number | 'terminal',
    info: { summary: string | null; snapshot: string; sha: string; branch: string }
  ): Promise<string> {
    const fs = (await import('fs')).promises;
    await fs.mkdir(this.logDir, { recursive: true });
    const docPath = `${this.logDir}/handoff-${iid}-${gen}.md`;
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
    return docPath;
  }

  /** Issue comment for a handoff round. `auto: true` → no manual-resume footer. */
  private handoffComment(p: {
    iid: number;
    tokens: number;
    gen: number | 'terminal';
    summary: string | null;
    snapshot: string;
    sha: string;
    branch: string;
    docPath: string;
    auto: boolean;
  }): string {
    const lines = [
      '<!-- afk-event: handoff -->',
      '**🔄 Context Handoff**',
      '',
      `- **Reason:** context_high (~${p.tokens} tokens)`,
      `- **Round:** ${p.gen}${p.auto ? '（自动继续中）' : ''}`,
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
    ];
    if (!p.auto) {
      lines.push(
        '',
        `**To resume:** Remove \`handoff::active\` label and re-trigger \`/afk-implement ${p.iid}\``,
      );
    }
    return lines.join('\n');
  }

  /** Goal text for a resumed round: read the handoff doc(s) before continuing. */
  private continueGoalText(goalBase: string, iid: number, gen: number): string {
    const docPath = `${this.logDir}/handoff-${iid}-${gen}.md`;
    return `继续${goalBase}（上下文已交接，请先阅读交接文档 ${docPath}；若存在更早的交接文档（同目录 handoff-${iid}-*.md），请一并阅读以获取完整上下文，再继续）`;
  }

  /** Fall back to the manual-resume protocol: handoff::active label, no further comments. */
  private async flipToManualHandoff(iid: number, session: string): Promise<void> {
    await this.tracker
      .addLabel(iid, 'handoff::active')
      .catch(err => logger.warn({ iid, err: (err as Error).message }, 'failed to add handoff::active label'));
    await this.tmux.killSession(session).catch(() => { /* already dead */ });
    await this.tmux.closeSession();
    this._cleanupType = 'success'; // handoff handler owns cleanup; finally skips
  }

  /**
   * Terminal handoff (handoff budget exhausted): keep today's observable
   * behavior — recovery comment + handoff::active label, session killed,
   * finally skips cleanup. The summary is now also captured into the doc.
   */
  private async terminalHandoff(
    iid: number,
    worktreePath: string,
    session: string,
    tokens: number
  ): Promise<{ success: boolean }> {
    this.killWatchdog(); // stale watchdog must not later write a timeout signal into the retained worktree
    const info = await this.requestHandoffSummary(iid, session, worktreePath);
    const docPath = await this.writeHandoffDoc(iid, 'terminal', info);
    await this.tracker.addLabel(iid, 'handoff::active');
    await this.tracker.addComment(iid, this.handoffComment({ ...info, iid, tokens, gen: 'terminal', docPath, auto: false }));
    await this.tmux.killSession(session).catch(() => {});
    await this.tmux.closeSession();
    this._cleanupType = 'success';
    return { success: false };
  }

  /**
   * Push worktree branch to origin
   */
  private async pushBranch(worktreePath: string): Promise<void> {
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(worktreePath);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    await git.push('origin', branch, ['--set-upstream']);
  }

  /**
   * Create MR/PR via the tracker provider (GitHub: octokit PRs, GitLab: API).
   * Returns the MR/PR web URL for logging.
   */
  private async createMR(iid: number, worktreePath: string, targetBranch: string): Promise<string> {
    const { simpleGit } = await import('simple-git');
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
