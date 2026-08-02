import { promises as fs } from 'fs';
import { join } from 'path';
import { simpleGit } from 'simple-git';
import type { TrackerProvider } from '../core/tracker/types';
import { TmuxClient } from '../core/tmux/tmux';
import { clearSignal, logger, STATUS_FILENAME } from '../io';
import { TIMEOUTS } from '../constants';
import { Watchdog } from './watchdog';

/**
 * Path of a handoff recovery doc inside a worktree. The runner uses this to
 * build the resumed-round goal text; the coordinator uses it to write the doc.
 * Keeping the convention in one place stops the two from drifting.
 */
export function handoffDocPath(worktreePath: string, iid: number, gen: number): string {
  return join(worktreePath, '.afk', 'handoff', `handoff-${iid}-${gen}.md`);
}

export type HandoffMode = 'auto' | 'terminal';
export type HandoffOutcome = 'continued' | 'terminated';
export type TerminalReason = 'budget' | 'tokens';

export interface HandoffContext {
  iid: number;
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
    private readonly tracker: TrackerProvider,
    private readonly tmux: TmuxClient,
    private readonly watchdog: Watchdog,
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
    logger.info({ iid: ctx.iid, gen: ctx.gen }, 'auto-handoff starting');

    // Negotiate summary (throws -> unchanged crash path, surfaced to the runner).
    const info = await this.requestHandoffSummary(ctx.iid, ctx.session, ctx.wtPath);
    logger.info({ iid: ctx.iid, gen: ctx.gen, sha: info.sha, branch: info.branch, hasSummary: info.summary !== null }, 'handoff summary negotiated');
    const { path: docPath } = await this.writeHandoffDoc(ctx.wtPath, ctx.iid, ctx.gen, info);
    logger.info({ iid: ctx.iid, gen: ctx.gen, docPath }, 'handoff doc written');

    // In-progress record; no handoff::active label in auto mode (that label is
    // the manual-resume marker). Best-effort: a comment failure must not abort.
    await this.tracker
      .addComment(ctx.iid, this.handoffComment({ ...info, iid: ctx.iid, tokens: ctx.tokens, gen: ctx.gen, docPath }))
      .catch(err => logger.warn({ iid: ctx.iid, err }, 'failed to post auto-handoff comment'));
    logger.info({ iid: ctx.iid, gen: ctx.gen }, 'auto-handoff comment posted');

    try {
      await this.restartSession(ctx);
      logger.info({ iid: ctx.iid, gen: ctx.gen }, 'auto-handoff session restarted (continued)');
      return 'continued';
    } catch (err) {
      logger.error({ iid: ctx.iid, err, gen: ctx.gen }, 'auto-continue relaunch failed; flipping to manual handoff');
      await this.flipToManual(ctx.iid, ctx.session);
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
    logger.info({ iid: ctx.iid, gen: ctx.gen, session: ctx.session }, 'restartSession begin');
    await this.tmux.killSession(ctx.session).catch(() => { /* already dead */ });
    logger.info({ iid: ctx.iid, session: ctx.session }, 'restartSession: tmux killed');
    await this.tmux.closeSession();
    await clearSignal(ctx.wtPath); // a stale completion signal would end the next wait immediately
    logger.info({ iid: ctx.iid, wtPath: ctx.wtPath }, 'restartSession: signal cleared');
    await fs.rm(join(ctx.wtPath, '.afk', STATUS_FILENAME), { force: true }); // fresh session must not inherit old token data
    logger.info({ iid: ctx.iid, wtPath: ctx.wtPath }, 'restartSession: statusline data cleared');
    await this.tmux.createSession(ctx.session, ctx.wtPath);
    logger.info({ iid: ctx.iid, session: ctx.session }, 'restartSession: tmux created');
    // waitForPrompt returns boolean, does NOT throw.
    if (!await this.tmux.waitForPrompt(ctx.wtPath, 30_000)) {
      throw new Error(`relaunch: claude not ready within 30s (${ctx.wtPath})`);
    }
    logger.info({ iid: ctx.iid, session: ctx.session }, 'restartSession: prompt ready');
    this.watchdog.arm(ctx.session, ctx.hardTimeoutMs, ctx.iid, ctx.wtPath); // fresh full hardTimeoutMs per generation
    logger.info({ iid: ctx.iid, session: ctx.session, hardTimeoutMs: ctx.hardTimeoutMs }, 'restartSession: watchdog armed');
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
    logger.info({ iid: ctx.iid, reason }, 'terminal handoff starting');
    const info = await this.requestHandoffSummary(ctx.iid, ctx.session, ctx.wtPath);
    logger.info({ iid: ctx.iid, sha: info.sha, branch: info.branch, hasSummary: info.summary !== null }, 'terminal handoff summary negotiated');
    const doc = await this.writeHandoffDoc(ctx.wtPath, ctx.iid, 'terminal', info);
    logger.info({ iid: ctx.iid, docPath: doc.path }, 'terminal handoff doc written');
    const reasonText = reason === 'tokens' ? '已达总 token 上限' : '已达最大交接轮数';
    await this.tracker.addLabel(ctx.iid, 'handoff::active');
    logger.info({ iid: ctx.iid, label: 'handoff::active' }, 'tracker label added');
    await this.tracker.addComment(ctx.iid, [
      '<!-- afk-event: handoff -->',
      `**🔄 Context Handoff（终止：${reasonText}）**`,
      '',
      doc.content,
      '',
      `**To resume:** Remove \`handoff::active\` label and re-trigger \`/afk-implement ${ctx.iid}\``,
    ].join('\n'));
    logger.info({ iid: ctx.iid, event: 'handoff-terminal' }, 'terminal handoff comment posted');
    await this.tmux.killSession(ctx.session).catch(() => {});
    logger.info({ iid: ctx.iid, session: ctx.session }, 'terminal handoff session killed');
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
  private async requestHandoffSummary(iid: number, session: string, worktreePath: string): Promise<HandoffSummary> {
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
   * and it travels with the worktree - a resumed session reads it in place.
   */
  private async writeHandoffDoc(
    worktreePath: string,
    iid: number,
    gen: number | 'terminal',
    info: HandoffSummary,
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
  private handoffComment(p: HandoffSummary & { iid: number; tokens: number; gen: number; docPath: string }): string {
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

  /** Fall back to the manual-resume protocol: handoff::active label, session killed. */
  private async flipToManual(iid: number, session: string): Promise<void> {
    await this.tracker
      .addLabel(iid, 'handoff::active')
      .catch(err => logger.warn({ iid, err }, 'failed to add handoff::active label'));
    await this.tmux.killSession(session).catch(() => { /* already dead */ });
    await this.tmux.closeSession();
  }
}
