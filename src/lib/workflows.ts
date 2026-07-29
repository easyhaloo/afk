import { spawn } from 'child_process';
import type { SpawnOptions } from 'child_process';

/**
 * Detached spawn that works on both Linux and macOS.
 * `detached: true` + `stdio: 'ignore'` detaches from TTY on both platforms.
 */
function spawnDetached(file: string, args: string[], opts: SpawnOptions): void {
  spawn(file, args, { ...opts, stdio: 'ignore', detached: true } as SpawnOptions).unref();
}
import type { TrackerProvider, Platform } from './core/tracker/types';
import { TmuxClient } from './tmux';
import { WorktreeManager } from './worktree';
import { getTokenUsage, configureStatusline, logger } from './io';
import type { Signal } from './schemas';
import { TIMEOUTS, CONTEXT } from './constants';

export interface RunnerOptions {
  iid: number;
  session: string;
  targetBranch: string;
  baseBranch?: string;
  maxRetries?: number;
  hardTimeoutMs?: number;
  completionTimeoutMs?: number;
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
    } = options;

    let succeeded = false;
    try {
      const result = await this.runBody(options, {
        iid, session, targetBranch, baseBranch,
        maxRetries, hardTimeoutMs, completionTimeoutMs,
      });
      succeeded = result.success;
      return result;
    } finally {
      // Cleanup: close Control Mode connection and worktree
      await this.tmux.closeSession();
      await this.worktree.cleanup(iid, !succeeded);
    }
  }

  private async runBody(
    options: RunnerOptions,
    ctx: {
      iid: number; session: string; targetBranch: string;
      baseBranch: string; maxRetries: number;
      hardTimeoutMs: number; completionTimeoutMs: number;
    }
  ): Promise<{ success: boolean; url?: string }> {
    const { iid, session, targetBranch, baseBranch, maxRetries, hardTimeoutMs, completionTimeoutMs } = ctx;

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

    // ── Phase 1 — Implement ────────────────────────────────────────────────
    await this.tmux.sendGoal(wt.path, session, 'main', `实现 issue #${iid} 的功能需求`, 'goal_complete');

    const phase1Signal = await this.tmux.waitForAnySignal(
      session, 'main',
      ['goal_complete', 'timeout', 'context_high'],
      wt.path, completionTimeoutMs
    );

    if (!phase1Signal || phase1Signal.type === 'timeout') {
      return this.handleTimeout(iid, wt.path, session, hardTimeoutMs);
    }
    if (phase1Signal.type === 'context_high') {
      return this.verifyAndHandoff(iid, wt.path, session);
    }

    // ── Phase 2 — Verify AC ────────────────────────────────────────────────
    await this.tmux.sendGoal(wt.path, session, 'main', `验证 issue #${iid} 的 AC 全部通过`, 'ac_result');

    const phase2Signal = await this.tmux.waitForAnySignal(
      session, 'main',
      ['ac_result', 'timeout', 'context_high'],
      wt.path, completionTimeoutMs
    );

    if (!phase2Signal || phase2Signal.type === 'timeout') {
      return this.handleTimeout(iid, wt.path, session, hardTimeoutMs);
    }
    if (phase2Signal.type === 'context_high') {
      return this.verifyAndHandoff(iid, wt.path, session);
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
   * Handle hard timeout: capture session, log, comment, cleanup
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

    await this.tracker.addComment(iid, `<!-- afk-event: timeout -->
**⏱️ Hard Timeout**

Session exceeded ${Math.round(timeoutMs / 60000)}min and was force killed.

- **Log:** \`${logPath}\`

**Recovery:** Remove \`mode::hitl\` label and re-trigger \`/afk-implement ${iid}\``);

    await this.tracker.addLabel(iid, 'mode::hitl');
    await this.tmux.killSession(session);
    await this.worktree.updateStatus(iid, 'failed');

    return { success: false };
  }

  /**
   * Verify context_high signal objectively before triggering handoff.
   * Returns early if pane-reported tokens are below threshold.
   */
  private async verifyAndHandoff(
    iid: number,
    worktreePath: string,
    session: string
  ): Promise<{ success: boolean }> {
    const usage = await getTokenUsage(worktreePath);

    if (usage.total === 0) {
      logger.warn({ iid }, 'context_high signal received but no token data; treating as below threshold');
      return { success: false };
    }

    if (usage.total < CONTEXT.HIGH_THRESHOLD) {
      logger.info(
        { iid, tokens: usage.total, threshold: CONTEXT.HIGH_THRESHOLD },
        'context_high signal ignored: below threshold'
      );
      return { success: false };
    }

    logger.info(
      { iid, tokens: usage.total, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, threshold: CONTEXT.HIGH_THRESHOLD },
      'context_high verified; triggering handoff'
    );
    return this.handleHandoff(iid, worktreePath, session, usage.total);
  }

  /**
   * Handle context handoff: ask agent to summarize, capture snapshot, post to GitLab
   */
  private async handleHandoff(
    iid: number,
    worktreePath: string,
    session: string,
    tokens: number
  ): Promise<{ success: boolean }> {
    // Ask agent to summarize progress
    await this.tmux.sendKeys(session, 'main', '/resume Context 接近上限，请总结当前进度：');
    await this.tmux.sendKeys(session, 'main', '1. 已完成的工作（简要列表）');
    await this.tmux.sendKeys(session, 'main', '2. 当前正在做什么');
    await this.tmux.sendKeys(session, 'main', '3. 接下来需要做什么');
    await this.tmux.sendKeys(session, 'main', '完成后创建信号：cat > .afk-signal.json <<EOF');
    await this.tmux.sendKeys(session, 'main', '{"type":"handoff_ready","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","summary":"<总结>"}');
    await this.tmux.sendKeys(session, 'main', 'EOF');
    await this.tmux.sendKeys(session, 'main', '（或直接回复：HANDOFF_READY）');

    // Wait for handoff_ready signal
    const signal = await this.tmux.waitForSignal(session, 'main', 'handoff_ready', worktreePath, TIMEOUTS.HANDOFF_TIMEOUT);

    const snapshot = await this.tmux.capturePane(session, 'main', { lines: 100, history: 200 });
    const git = (await import('simple-git')).simpleGit(worktreePath);
    const sha = await git.revparse('HEAD');
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);

    await this.tracker.addLabel(iid, 'handoff::active');
    await this.tracker.addComment(iid, `<!-- afk-event: handoff -->
**🔄 Context Handoff**

- **Reason:** context_high (~${tokens} tokens)
- **Branch:** \`${branch}\`
- **Commit:** \`${sha}\`

<details>
<summary>Session Snapshot (last 100 lines)</summary>

\`\`\`
${snapshot}
\`\`\`
</details>

**To resume:** Remove \`handoff::active\` label and re-trigger \`/afk-implement ${iid}\``);

    await this.tmux.killSession(session);
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
      `cat > "${signalPath}.tmp" <<'EOF'\n` +
      `{"type":"timeout","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}\n` +
      `EOF\n` +
      `mv "${signalPath}.tmp" "${signalPath}" 2>/dev/null; ` +
      `tmux kill-session -t "${session}" 2>/dev/null || true; ` +
      `echo "WATCHDOG:${iid}:${session}:${hardTimeoutMs}" >> "${this.logDir}/watchdog.log"`;
    spawnDetached('bash', ['-c', shellCmd], { cwd: process.cwd() });
  }
}
