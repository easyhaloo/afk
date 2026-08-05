import { promises as fs } from 'fs';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import type { BacklogProvider } from '../core/backlog';
import type { TmuxClient } from '../core/tmux';
import { logger, STATUS_FILENAME, clearSignal } from '../io';
import type { WorkflowConfig } from '../core/config/manager';
import { Watchdog } from './watchdog';

/**
 * Path of a handoff recovery doc inside a worktree. The runner uses this to
 * build the resumed-round goal text; the coordinator uses it to write the doc.
 * Keeping the convention in one place stops the two from drifting.
 */
export function handoffDocPath(worktreePath: string, backlogId: string, gen: number): string {
  return join(worktreePath, '.afk', 'handoff', `handoff-${backlogId}-${gen}.md`);
}

export type HandoffMode = 'auto' | 'terminal';
export type HandoffOutcome = 'continued' | 'terminated';
export type TerminalReason = 'budget' | 'tokens';

export interface HandoffContext {
  backlogId: string;
  session: string;
  wtPath: string;
  /** Per-generation hard timeout (ms) - re-armed on restart. */
  hardTimeoutMs: number;
  /** Generation number for the auto-handoff doc (1-based). Ignored for terminal. */
  gen: number;
  /** Token count that triggered the handoff (advisory, surfaces in the comment). */
  tokens: number;
}

interface HandoffSummary {
  summary: string | null;
  snapshot: string;
  sha: string;
  branch: string;
}

/**
 * Owns every way a context handoff can resolve.
 *
 * The runner's phase loop decides WHEN to hand off (context_high, budget
 * exhausted); this module decides HOW: negotiate a summary with the agent,
 * persist a recovery doc, post an issue comment, then either relaunch the
 * session (auto) or terminate with a full handoff doc (terminal).
 *
 * One interface - {@link handoff} - hides the negotiation/persist/notify/
 * relaunch cluster. The manual-flip fallback is an internal failure mode of
 * 'auto' (returns 'terminated'); the runner never sees it as a distinct case.
 */
export class HandoffCoordinator {
  constructor(
    private readonly backlog: BacklogProvider,
    private readonly tmux: TmuxClient,
    private readonly watchdog: Watchdog,
    private readonly config: WorkflowConfig,
  ) {}

  /**
   * Perform a handoff.
   *
   * - 'auto': disarm the watchdog, negotiate a summary, write a doc + comment,
   *   relaunch the session. Returns 'continued' on a clean relaunch, or
   *   'terminated' after flipping to the manual-resume protocol on relaunch
   *   failure.
   * - 'terminal': disarm, negotiate, write a terminal doc, embed it in a
   *   comment, kill the session. Always returns 'terminated'.
   */
  async handoff(
    ctx: HandoffContext,
    mode: HandoffMode,
    reason?: TerminalReason,
  ): Promise<HandoffOutcome> {
    return mode === 'auto' ? this.autoHandoff(ctx) : this.terminalHandoff(ctx, reason);
  }

  // ── auto ───────────────────────────────────────────────────────────────────

  /**
   * Auto-handoff round: negotiate -> persist -> notify -> relaunch.
   * Relaunch failure flips to the manual-resume protocol (recovery doc already
   * posted) and returns 'terminated'.
   */
  private async autoHandoff(ctx: HandoffContext): Promise<HandoffOutcome> {
    // Stop the hard budget during summary negotiation; the old watchdog's
    // timeout signal would clobber handoff_ready and kill the session mid-negotiation.
    this.watchdog.disarm();
    logger.info({ backlogId: ctx.backlogId, gen: ctx.gen }, 'auto-handoff starting');

    // Negotiate summary (throws -> unchanged crash path, surfaced to the runner).
    const info = await this.requestHandoffSummary(ctx.backlogId, ctx.session, ctx.wtPath);
    logger.info({ backlogId: ctx.backlogId, gen: ctx.gen, sha: info.sha, branch: info.branch, hasSummary: info.summary !== null }, 'handoff summary negotiated');
    const { path: docPath } = await this.writeHandoffDoc(ctx.wtPath, ctx.backlogId, ctx.gen, info);
    logger.info({ backlogId: ctx.backlogId, gen: ctx.gen, docPath }, 'handoff doc written');

    try {
      await this.restartSession(ctx);
      logger.info({ backlogId: ctx.backlogId, gen: ctx.gen }, 'auto-handoff session restarted (continued)');
      return 'continued';
    } catch (err) {
      logger.error({ backlogId: ctx.backlogId, err, gen: ctx.gen }, 'auto-continue relaunch failed; marking blocked');
      await this.flipToManual(ctx.backlogId, ctx.session);
      return 'terminated';
    }
  }

  /**
   * Kill the session and start a fresh one with a new watchdog. The stale
   * control-mode connection, signal file, and statusline data must all be
   * cleared first - a stale connection reuses the session name and breaks
   * sendKeys, and stale data would make waitForPrompt return instantly and
   * getTokenUsage read the old session's tokens.
   */
  private async restartSession(ctx: HandoffContext): Promise<void> {
    logger.info({ backlogId: ctx.backlogId, gen: ctx.gen, session: ctx.session }, 'restartSession begin');
    await this.tmux.killSession(ctx.session).catch(() => { /* already dead */ });
    logger.info({ backlogId: ctx.backlogId, session: ctx.session }, 'restartSession: tmux killed');
    await this.tmux.closeSession();
    await clearSignal(ctx.wtPath); // stale completion signal must not end the next wait immediately
    await fs.rm(join(ctx.wtPath, '.afk', STATUS_FILENAME), { force: true }); // fresh session must not inherit old token data
    logger.info({ backlogId: ctx.backlogId, wtPath: ctx.wtPath }, 'restartSession: statusline data cleared');
    await this.tmux.createSession(ctx.session, ctx.wtPath);
    logger.info({ backlogId: ctx.backlogId, session: ctx.session }, 'restartSession: tmux created');
    // waitForPrompt returns boolean, does NOT throw.
    if (!await this.tmux.waitForPrompt(ctx.wtPath, this.config.promptTimeout)) {
      throw new Error(`relaunch: claude not ready within ${this.config.promptTimeout}ms (${ctx.wtPath})`);
    }
    logger.info({ backlogId: ctx.backlogId, session: ctx.session }, 'restartSession: prompt ready');
    this.watchdog.arm(ctx.session, ctx.hardTimeoutMs, Number(ctx.backlogId) || 0, ctx.wtPath);
    logger.info({ backlogId: ctx.backlogId, session: ctx.session, hardTimeoutMs: ctx.hardTimeoutMs }, 'restartSession: watchdog armed');
  }

  // ── terminal ───────────────────────────────────────────────────────────────

  /**
   * Terminal handoff (handoff budget or total-token budget exhausted):
   * handoff::active label + recovery comment, session killed. The recovery
   * comment EMBEDS the full handoff doc (no file-path reference) - the
   * resume path reads everything from the issue. The worktree (with the doc
   * on disk) is retained for manual resume.
   */
  private async terminalHandoff(ctx: HandoffContext, reason?: TerminalReason): Promise<HandoffOutcome> {
    this.watchdog.disarm(); // stale watchdog must not later write a timeout signal into the retained worktree
    logger.info({ backlogId: ctx.backlogId, reason }, 'terminal handoff starting');
    const info = await this.requestHandoffSummary(ctx.backlogId, ctx.session, ctx.wtPath);
    logger.info({ backlogId: ctx.backlogId, sha: info.sha, branch: info.branch, hasSummary: info.summary !== null }, 'terminal handoff summary negotiated');
    const doc = await this.writeHandoffDoc(ctx.wtPath, ctx.backlogId, 'terminal', info);
    logger.info({ backlogId: ctx.backlogId, docPath: doc.path }, 'terminal handoff doc written');
    await this.backlog.transition(ctx.backlogId, 'blocked', { reason: reason ?? 'context handoff exhausted' });
    await this.backlog.setExecutionMode(ctx.backlogId, 'hitl');
    await this.tmux.killSession(ctx.session).catch(() => {});
    logger.info({ backlogId: ctx.backlogId, session: ctx.session }, 'terminal handoff session killed');
    await this.tmux.closeSession();
    return 'terminated';
  }

  // ── shared helpers ─────────────────────────────────────────────────────────

  /**
   * Negotiate the handoff summary with the agent: type the request once
   * (plain text, not a slash command - /resume would open the session
   * picker), wait for handoff_ready, and fall back to the pane snapshot when
   * no summary arrives in time.
   */
  private async requestHandoffSummary(backlogId: string, session: string, worktreePath: string): Promise<HandoffSummary> {
    await this.typeHandoffRequest(session);

    const signal = await this.tmux.waitForSignal(session, 'main', 'handoff_ready', worktreePath, this.config.handoffTimeout);

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
   * and it travels with the worktree - a resumed session reads it in place.
   */
  private async writeHandoffDoc(
    worktreePath: string,
    backlogId: string,
    gen: number | 'terminal',
    info: HandoffSummary,
  ): Promise<{ path: string; content: string }> {
    const handoffDir = join(worktreePath, '.afk', 'handoff');
    await fs.mkdir(handoffDir, { recursive: true });
    const docPath = join(handoffDir, `handoff-${backlogId}-${gen}.md`);
    const content = [
      `# Handoff ${backlogId} (round ${gen})`,
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

  /** Mark the backlog blocked/hitl and terminate the session. */
  private async flipToManual(backlogId: string, session: string): Promise<void> {
    await this.backlog.transition(backlogId, 'blocked', { reason: 'handoff relaunch failed' });
    await this.backlog.setExecutionMode(backlogId, 'hitl');
    await this.tmux.killSession(session).catch(() => { /* already dead */ });
    await this.tmux.closeSession();
  }
}

/**
 * Factory: create a HandoffCoordinator with its required dependencies.
 * Tests may inject a fake via RunnerDependencies.coordinatorFactory instead.
 */
export function createHandoffCoordinator(deps: {
  backlog: BacklogProvider;
  tmux: TmuxClient;
  watchdog: Watchdog;
  config: WorkflowConfig;
}): HandoffCoordinator {
  return new HandoffCoordinator(deps.backlog, deps.tmux, deps.watchdog, deps.config);
}
