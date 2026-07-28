import { spawn } from 'child_process';
import type { TrackerProvider, Platform } from './core/tracker/types';
import { TmuxClient } from './tmux';
import { WorktreeManager } from './worktree';
import { getTokenUsage, configureStatusline } from './io';
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
 * Pattern: launch → waitForAnySignal → process result
 *
 * Agent responsibilities (via skill instructions):
 *   - On goal complete: write goal_complete signal (Runner verifies commits exist)
 *   - On AC done:       write ac_result signal (advisory only — Runner
 *                        re-verifies via verifyAC(), never trusts result field)
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

    // Auto-detect platform only if not provided and will be used
    const platform = options.platform;

    // ── Step 1: Fetch issue + AC ────────────────────────────────────────────
    const issue = await this.tracker.getIssue(iid);
    const ac = this.tracker.parseAC(issue);
    if (ac.items.length === 0) {
      throw new Error(
        `Issue #${iid} has no AC. Add AC labels (ac::1::..., ac::2::...) or ` +
        `a "## AC" markdown section.`
      );
    }

    const goalText = ac.items.map((item) => `${item.index}. ${item.text}`).join('\n');
    const traceId = `trace-${Date.now()}-${iid}`;

    // ── Step 2: Create worktree ─────────────────────────────────────────────
    const wt = await this.worktree.create(iid, baseBranch);
    await this.worktree.updateStatus(iid, 'active');
    // Configure statusline so token counts are written to .afk/claude-status.json
    // for objective context_high verification.
    await configureStatusline(wt.path);

    // ── Step 3: Launch tmux session + inject /goal ──────────────────────────
    await this.tmux.createSession(session, wt.path, 'claude');
    await this.tmux.waitForPrompt(wt.path, 30000);
    await this.tmux.sendGoal(wt.path, session, 'main', goalText);

    // ── Step 4: Launch watchdog (detached, no blocking) ────────────────────
    this.startWatchdog(session, hardTimeoutMs, iid, wt.path);

    // ── Step 5: Post launch comment ─────────────────────────────────────────
    const goalLines = goalText.split('\n').length;
    const goalPreview = goalText.split('\n').slice(0, 5).join('\n');
    const launchBody = [
      '<!-- afk-event: launch -->',
      '**🚀 AFK Session Started**',
      '',
      `- **Worktree:** \`${wt.path}\``,
      `- **Branch:** \`${targetBranch}\``,
      `- **Session:** \`${session}\``,
      `- **Trace:** \`${traceId}\``,
      '',
      '**Goal:**',
      '```',
      goalPreview + (goalText.split('\n').length > 5 ? '\n...' : ''),
      '```',
      '',
      `> ${goalLines} lines total`,
    ].join('\n');
    await this.tracker.addComment(iid, launchBody);
    await this.tracker.addLabel(iid, `session::${session}`);
    await this.tracker.addLabel(iid, 'stage::afk-in-progress');
    await this.tracker.removeLabel(iid, 'stage::ready-for-issues');

    // ── Step 6: Wait for signal ─────────────────────────────────────────────
    const signal = await this.tmux.waitForAnySignal(
      session,
      'main',
      ['goal_complete', 'timeout', 'context_high'],
      wt.path,
      completionTimeoutMs
    );

    // ── Step 7: Process result ──────────────────────────────────────────────
    if (!signal) {
      console.warn(`⚠️  No signal received within ${completionTimeoutMs}ms for #${iid}`);
      return { success: false };
    }

    switch (signal.type) {
      case 'goal_complete':
        return this.autoWrapup(iid, wt.path, session, targetBranch, baseBranch, maxRetries, signal.sha);

      case 'timeout':
        return this.handleTimeout(iid, wt.path, session, hardTimeoutMs);

      case 'context_high':
        // Verify objectively: ignore signal if pane-reported tokens are below threshold.
        // The agent only acts as a trigger; the Runner judges.
        return this.verifyAndHandoff(iid, wt.path, session);

      default:
        console.warn(`⚠️  Unexpected signal type: ${(signal as Signal).type}`);
        return { success: false };
    }
  }

  /**
   * autoWrapup: push branch → ask agent to run AC → wait ac_result → MR or retry
   */
  private async autoWrapup(
    iid: number,
    worktreePath: string,
    session: string,
    targetBranch: string,
    baseBranch: string,
    maxRetries: number,
    sha?: string
  ): Promise<{ success: boolean; url?: string }> {
    // Push branch
    await this.pushBranch(worktreePath);

    // Ask agent to run AC checks
    const issue = await this.tracker.getIssue(iid);
    const ac = this.tracker.parseAC(issue);
    if (ac.items.length > 0) {
      await this.tmux.sendResumeWithAC(session, 'main', ac.items);
    }

    // Wait for AC signal (agent only notifies, does NOT adjudicate)
    const acSignal = await this.tmux.waitForSignal(session, 'main', 'ac_result', worktreePath, TIMEOUTS.AC_SIGNAL_TIMEOUT);

    // Runner verifies objectively: ignore agent's self-reported result.
    // Objective check: branch has commits ahead of base, AND AC items exist to verify.
    const acCheck = await this.verifyAC(iid, worktreePath, baseBranch);
    if (!acCheck.ok) {
      console.warn(`⚠️  AC verification failed: ${acCheck.reason}`);
      // If agent didn't even run AC or branch is empty, treat as failure
      if (!acSignal) {
        return this.handleACFail(iid, worktreePath, session, targetBranch, maxRetries);
      }
    }

    // AC passed → create MR
    const mrUrl = await this.createMR(iid, worktreePath, targetBranch);

    // Query MR/PR status and pipeline
    try {
      const mrId = this.extractMRIdFromUrl(mrUrl);
      if (mrId) {
        const mr = await this.tracker.getMR(mrId);
        console.log(`✓ MR status: ${mr.state}, pipeline: ${mr.pipeline?.status || 'N/A'}`);
      }
    } catch (err) {
      console.warn('Failed to query MR/PR status:', err);
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
   * Objective AC verification: check that real work happened.
   * This complements (does not replace) any agent-reported ac_result
   * signal — the agent's self-judgment is treated as advisory only.
   *
   * Checks:
   * 1. Branch has at least one commit ahead of base
   * 2. Issue description contains an AC section with verifiable items
   * 3. (Future) Tests pass — currently relies on agent signal + CI pipeline
   */
  private async verifyAC(
    iid: number,
    worktreePath: string,
    baseBranch: string
  ): Promise<{ ok: boolean; reason: string; commitCount?: number; acItemCount?: number }> {
    try {
      const { simpleGit } = await import('simple-git');
      const git = simpleGit(worktreePath);

      // Check 1: branch has commits ahead of base
      const log = await git.log([`${baseBranch}..HEAD`]);
      const commitCount = log.total;
      if (commitCount === 0) {
        return { ok: false, reason: 'no commits ahead of base branch', commitCount: 0 };
      }

      // Check 2: issue has AC section with items
      const issue = await this.tracker.getIssue(iid);
      const ac = this.tracker.parseAC(issue);
      if (ac.items.length === 0) {
        return { ok: false, reason: 'issue has no AC', commitCount, acItemCount: 0 };
      }

      return { ok: true, reason: 'passed', commitCount, acItemCount: ac.items.length };
    } catch (err) {
      return { ok: false, reason: `verification error: ${(err as Error).message}` };
    }
  }

  /**
   * Handle AC failure: increment retry count and retry, or escalate to HITL
   */
  private async handleACFail(
    iid: number,
    worktreePath: string,
    session: string,
    targetBranch: string,
    maxRetries: number
  ): Promise<{ success: boolean; url?: string }> {
    const issue = await this.tracker.getIssue(iid);
    const current = this.tracker.getRetryCount(issue);
    const newCount = current + 1;
    const withoutOld = issue.labels.filter(l => !/^retry-count::/.test(l));
    await this.tracker.updateIssue(iid, { labels: [...withoutOld, `retry-count::${newCount}`] });
    const retryCount = newCount;

    if (retryCount > maxRetries) {
      await this.tracker.addLabel(iid, 'mode::hitl');
      await this.tracker.addComment(iid, `❌ AC check failed after ${maxRetries} retries. Escalating to human review.`);
      await this.worktree.updateStatus(iid, 'failed');
      return { success: false };
    }

    console.log(`AC failed, retry ${retryCount}/${maxRetries}. Re-launching...`);
    await this.tmux.killSession(session);

    // Re-launch with new session name (agent sees previous commits + Next: trailer)
    const newSession = `${session}-retry-${retryCount}`;
    return this.run({
      iid,
      session: newSession,
      targetBranch,
      maxRetries,
    });
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

    await this.tracker.addLabel(iid, 'mode::timeout');
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
      console.warn(`⚠️  context_high signal received but no token data in .afk/claude-status.json; treating as below threshold`);
      return { success: false };
    }

    if (usage.total < CONTEXT.HIGH_THRESHOLD) {
      console.log(
        `ℹ️  context_high signal ignored: ${usage.total} tokens < ${CONTEXT.HIGH_THRESHOLD} threshold`
      );
      return { success: false };
    }

    console.log(
      `✓ context_high verified: ${usage.total} tokens (in:${usage.input} out:${usage.output} cache_r:${usage.cacheRead}) ≥ ${CONTEXT.HIGH_THRESHOLD}; triggering handoff`
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
   * Create MR via glab CLI with JSON output for reliable parsing.
   */
  private async createMR(iid: number, worktreePath: string, targetBranch: string): Promise<string> {
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(worktreePath);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const issue = await this.tracker.getIssue(iid);

    return new Promise((resolve, reject) => {
      const proc = spawn('glab', [
        'mr', 'create',
        '--source-branch', branch,
        '--target-branch', targetBranch,
        '--title', `Draft: Resolve #${iid}`,
        '--description', `Closes #${iid}\n\n${issue.title}`,
        '--yes', '--draft',
        '--output', 'json',
      ], { cwd: worktreePath, stdio: 'pipe' });

      let stdout = '', stderr = '';
      proc.stdout?.on('data', d => stdout += d);
      proc.stderr?.on('data', d => stderr += d);
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`glab mr create failed: ${stderr || stdout}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout);
          const url = parsed.web_url ?? parsed.url;
          if (typeof url === 'string' && url.length > 0) {
            resolve(url);
          } else {
            reject(new Error(`glab mr create succeeded but no URL in JSON: ${stdout}`));
          }
        } catch {
          // Fallback for older glab versions without --output json support:
          // regex-extract first https URL from stdout.
          const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
          if (urlMatch) {
            resolve(urlMatch[1]);
          } else {
            reject(new Error(`glab mr create produced unparseable output: ${stdout}`));
          }
        }
      });
    });
  }

  /**
   * Start hard-timeout watchdog as detached process.
   * Fires after hardTimeoutMs: writes timeout signal then kills the tmux session,
   * so the WorkflowRunner's main loop can pick up the signal via file polling
   * rather than relying on tmux exit codes.
   */
  private startWatchdog(session: string, hardTimeoutMs: number, iid: number, worktreePath: string): void {
    const signalPath = `${worktreePath}/.afk-signal.json`;
    spawn('setsid', [
      'bash', '-c',
      `sleep ${hardTimeoutMs / 1000} && ` +
      // Write a timeout signal atomically so Runner can detect hard timeout.
      `cat > "${signalPath}.tmp" <<'EOF'
{"type":"timeout","timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
mv "${signalPath}.tmp" "${signalPath}" 2>/dev/null; ` +
      `tmux kill-session -t "${session}" 2>/dev/null || true; ` +
      `echo "WATCHDOG:${iid}:${session}:${hardTimeoutMs}" >> "${this.logDir}/watchdog.log"`,
    ], {
      stdio: 'ignore',
      detached: true,
      cwd: process.cwd(),
    }).unref();
  }
}
