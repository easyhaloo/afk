import { spawn } from 'child_process';
import { GitLabClient } from './gitlab';
import { detectPlatform } from './core/tracker/detect';
import type { Platform } from './core/tracker/types';
import { TmuxClient } from './tmux';
import { WorktreeManager } from './worktree';
import { writeSignal, readSignal } from './io';
import { getCurrentTimestamp } from './schemas';
import type { Signal, TimeoutSignal } from './schemas';
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
 *   - On goal complete:  write goal_complete signal, exit(0)
 *   - On AC fail:        write ac_result {result:'FAIL'}, exit(41)
 *   - On context high:   write context_high signal, exit(43)
 *                        (Runner verifies pane tokens ≥ CONTEXT.HIGH_THRESHOLD
 *                         before acting — signal alone is just a trigger)
 *   - On idle:           write idle signal, exit(44)
 *
 * Watchdog: detached setsid process kills session after hardTimeoutMs → exit(42)
 */
export class WorkflowRunner {
  private gitlab: GitLabClient;
  private tmux: TmuxClient;
  private worktree: WorktreeManager;
  private logDir: string;

  constructor(gitlab: GitLabClient) {
    this.gitlab = gitlab;
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
    const issue = await this.gitlab.getIssue(iid);
    const ac = this.gitlab.parseAC(issue.description);
    if (!ac) throw new Error(`Issue #${iid} has no AC section`);

    const goalText = ac.items.map((item, idx) => `${idx + 1}. ${item}`).join('\n');
    const traceId = `trace-${Date.now()}-${iid}`;

    // ── Step 2: Create worktree ─────────────────────────────────────────────
    const wt = await this.worktree.create(iid, baseBranch);
    await this.worktree.updateStatus(iid, 'active');

    // ── Step 3: Launch tmux session + inject /goal ──────────────────────────
    await this.tmux.createSession(session, wt.path, 'claude');
    await this.tmux.waitForPrompt(session, 'main', 30000);
    await this.tmux.sendGoal(session, 'main', goalText);

    // ── Step 4: Launch watchdog (detached, no blocking) ────────────────────
    this.startWatchdog(session, hardTimeoutMs, iid);

    // ── Step 5: Post launch comment ─────────────────────────────────────────
    const goalLines = goalText.split('\n').length;
    const goalPreview = goalText.split('\n').slice(0, 5).join('\n');
    await this.gitlab.createLaunchComment(iid, {
      worktreePath: wt.path,
      targetBranch,
      session,
      traceId,
      goalLines,
      goalPreview,
    });
    await this.gitlab.addLabel(iid, `session::${session}`);
    await this.gitlab.addLabel(iid, 'stage::afk-in-progress');
    await this.gitlab.removeLabel(iid, 'stage::ready-for-issues');

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
        return this.autoWrapup(iid, wt.path, session, targetBranch, maxRetries, signal.sha);

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
    maxRetries: number,
    sha?: string
  ): Promise<{ success: boolean; url?: string }> {
    // Push branch
    await this.pushBranch(worktreePath);

    // Ask agent to run AC checks
    const issue = await this.gitlab.getIssue(iid);
    const ac = this.gitlab.parseAC(issue.description);
    if (ac) {
      await this.tmux.sendResumeWithAC(session, 'main', ac.items);
    }

    // Wait for AC result
    const acSignal = await this.tmux.waitForSignal(session, 'main', 'ac_result', worktreePath, TIMEOUTS.AC_SIGNAL_TIMEOUT);

    if (!acSignal || acSignal.type !== 'ac_result' || acSignal.result !== 'PASS') {
      // AC failed → retry or escalate
      return this.handleACFail(iid, worktreePath, session, targetBranch, maxRetries);
    }

    // AC passed → create MR
    const mrUrl = await this.createMR(iid, worktreePath, targetBranch);

    // Query MR/PR status and pipeline
    try {
      const mrId = this.extractMRIdFromUrl(mrUrl);
      if (mrId) {
        const mr = await this.gitlab.getMR(mrId);
        console.log(`✓ MR status: ${mr.state}, pipeline: ${mr.pipeline?.status || 'N/A'}`);
      }
    } catch (err) {
      console.warn('Failed to query MR/PR status:', err);
    }

    await this.gitlab.addLabel(iid, 'stage::qa');
    await this.gitlab.removeLabel(iid, 'stage::afk-in-progress');

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
   * Handle AC failure: increment retry count and retry, or escalate to HITL
   */
  private async handleACFail(
    iid: number,
    worktreePath: string,
    session: string,
    targetBranch: string,
    maxRetries: number
  ): Promise<{ success: boolean; url?: string }> {
    const retryCount = await this.gitlab.incrementRetryCount(iid);

    if (retryCount > maxRetries) {
      await this.gitlab.addLabel(iid, 'mode::hitl');
      await this.gitlab.addComment(iid, `❌ AC check failed after ${maxRetries} retries. Escalating to human review.`);
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

    await this.gitlab.addComment(iid, `<!-- afk-event: timeout -->
**⏱️ Hard Timeout**

Session exceeded ${Math.round(timeoutMs / 60000)}min and was force killed.

- **Log:** \`${logPath}\`

**Recovery:** Remove \`mode::hitl\` label and re-trigger \`/afk-implement ${iid}\``);

    await this.gitlab.addLabel(iid, 'mode::timeout');
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
    const tokens = await this.tmux.getContextTokens(session, 'main');

    if (tokens === 0) {
      console.warn(`⚠️  context_high signal received but could not read pane tokens; treating as below threshold`);
      return { success: false };
    }

    if (tokens < CONTEXT.HIGH_THRESHOLD) {
      console.log(
        `ℹ️  context_high signal ignored: ${tokens} tokens < ${CONTEXT.HIGH_THRESHOLD} threshold`
      );
      return { success: false };
    }

    console.log(
      `✓ context_high verified: ${tokens} tokens ≥ ${CONTEXT.HIGH_THRESHOLD}; triggering handoff`
    );
    return this.handleHandoff(iid, worktreePath, session, tokens);
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
    const sha = await this.gitlab.getWorktreeSHA(worktreePath);
    const branch = (await import('simple-git')).simpleGit(worktreePath).revparse(['--abbrev-ref', 'HEAD']);

    await this.gitlab.addLabel(iid, 'handoff::active');
    await this.gitlab.addComment(iid, `<!-- afk-event: handoff -->
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
   * Create MR via glab CLI
   */
  private async createMR(iid: number, worktreePath: string, targetBranch: string): Promise<string> {
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(worktreePath);
    const branch = await git.revparse(['--abbrev-ref', 'HEAD']);
    const issue = await this.gitlab.getIssue(iid);

    return new Promise((resolve, reject) => {
      const proc = spawn('glab', [
        'mr', 'create',
        '--source-branch', branch,
        '--target-branch', targetBranch,
        '--title', `Draft: Resolve #${iid}`,
        '--description', `Closes #${iid}\n\n${issue.title}`,
        '--yes', '--draft',
      ], { cwd: worktreePath, stdio: 'pipe' });

      let stdout = '', stderr = '';
      proc.stdout?.on('data', d => stdout += d);
      proc.stderr?.on('data', d => stderr += d);
      proc.on('close', (code) => {
        if (code === 0) {
          const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
          resolve(urlMatch?.[1] ?? stdout.trim());
        } else {
          reject(new Error(`glab mr create failed: ${stderr || stdout}`));
        }
      });
    });
  }

  /**
   * Start hard-timeout watchdog as detached process.
   * Fires after hardTimeoutMs, kills the tmux session (exit 42).
   */
  private startWatchdog(session: string, hardTimeoutMs: number, iid: number): void {
    const selfBin = process.argv[0];
    const selfArgs = process.argv.slice(1);

    spawn('setsid', [
      'bash', '-c',
      `sleep ${hardTimeoutMs / 1000} && tmux kill-session -t "${session}" 2>/dev/null || true; ` +
      `echo "WATCHDOG:${iid}:${session}:${hardTimeoutMs}" >> "${this.logDir}/watchdog.log"`,
    ], {
      stdio: 'ignore',
      detached: true,
      cwd: process.cwd(),
    }).unref();
  }
}
