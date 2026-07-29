import { TmuxClient } from './core/tmux/tmux';
import { WorktreeManager } from './worktree';
import { configureStatusline, logger } from './io';
import { TIMEOUTS } from './constants';
import type { TrackerProvider } from './core/tracker/types';

/**
 * QA Runner — event-driven worker for verifying AC on merged code.
 *
 * After a WorkflowRunner completes Phase 1 + Phase 2 and creates an MR,
 * the issue is labeled stage::qa. QARunner picks it up:
 *
 * 1. Create worktree from PRD baseline branch
 * 2. Merge the feature branch into the worktree
 * 3. Launch tmux + agent, send /goal to verify AC
 * 4. Wait for ac_result signal
 * 5. On pass: merge MR, label stage::done
 * 6. On fail: label mode::hitl + comment with details
 *
 * Supports both per-issue and PRD-level batch verification.
 */
export class QARunner {
  private tracker: TrackerProvider;
  private tmux: TmuxClient;
  private worktree: WorktreeManager;
  private logDir: string;

  constructor(tracker: TrackerProvider) {
    this.tracker = tracker;
    this.tmux = new TmuxClient();
    this.worktree = new WorktreeManager();
    this.logDir = `${process.env.HOME}/.claude/logs/afk/qa`;
  }

  /**
   * Run QA for a single issue.
   */
  async process(iid: number): Promise<{ success: boolean; mrUrl?: string }> {
    logger.info({ iid }, 'QA processing started');

    const issue = await this.tracker.getIssue(iid);
    const baselineBranch = await this.tracker.detectTargetBranch(iid);
    const session = `qa-${iid}-${Date.now()}`;

    let wt;
    try {
      // ── Step 1: Create worktree from PRD baseline ──────────────────────────
      wt = await this.worktree.create(iid, baselineBranch);
      await this.worktree.updateStatus(iid, 'active');
      await configureStatusline(wt.path);

      // ── Step 2: Merge feature branch ───────────────────────────────────────
      const featureBranch = await this.resolveFeatureBranch(iid);
      if (!featureBranch) {
        await this.tracker.addComment(iid, '<!-- afk-event: qa-failed -->\n**❌ QA Failed**\n\nCould not resolve feature branch.');
        await this.tracker.addLabel(iid, 'mode::hitl');
        return { success: false };
      }

      await this.mergeBranch(wt.path, featureBranch);

      // ── Step 3: Launch tmux + agent ───────────────────────────────────────
      await this.tmux.createSession(session, wt.path);
      await this.tmux.waitForPrompt(wt.path, 30000);

      // ── Step 4: Send /goal to verify AC ───────────────────────────────────
      await this.tmux.sendGoal(wt.path, session, 'main', `验证 issue #${iid} 的 AC 在合并后的代码上全部通过`, 'ac_result');

      // Log start
      await this.tracker.addComment(iid, [
        '<!-- afk-event: qa-start -->',
        '**🔍 QA Verification Started**',
        '',
        `- **Session:** \`${session}\``,
        `- **Baseline:** \`${baselineBranch}\``,
        `- **Feature:** \`${featureBranch}\``,
      ].join('\n'));

      // ── Step 5: Wait for ac_result ────────────────────────────────────────
      const signal = await this.tmux.waitForSignal(
        session, 'main', 'ac_result', wt.path,
        TIMEOUTS.WORKFLOW_COMPLETION_TIMEOUT
      );

      if (!signal) {
        return this.handleTimeout(iid, wt.path, session);
      }

      // ── Step 6: Process result ─────────────────────────────────────────────
      return await this.handleACResult(iid, wt.path, session, signal);

    } finally {
      await this.tmux.closeSession();
      if (wt) {
        await this.worktree.cleanup(iid, false);
      }
    }
  }

  /**
   * Run QA for all issues under a PRD.
   * Fetches all open issues with base::prd-<N> label and stage::qa,
   * then verifies each one sequentially.
   */
  async processPRD(prdIid: number): Promise<{ success: boolean; results: Array<{ iid: number; passed: boolean }> }> {
    logger.info({ prdIid }, 'PRD-level QA started');

    const issues = await this.tracker.listIssues({
      labels: [`base::prd-${prdIid}`, 'stage::qa'],
      state: 'opened',
    });

    if (issues.length === 0) {
      logger.info({ prdIid }, 'no issues found for PRD QA');
      return { success: true, results: [] };
    }

    const results: Array<{ iid: number; passed: boolean }> = [];
    for (const issue of issues) {
      const result = await this.process(issue.id);
      results.push({ iid: issue.id, passed: result.success });
    }

    const allPassed = results.every(r => r.passed);
    return { success: allPassed, results };
  }

  /**
   * Resolve the feature branch for an issue.
   * Looks for the most recently pushed branch matching the expected pattern.
   */
  private async resolveFeatureBranch(iid: number): Promise<string | null> {
    const issue = await this.tracker.getIssue(iid);
    const baselineBranch = await this.tracker.detectTargetBranch(iid);

    // The feature branch follows the worktree naming convention
    const expectedBranch = `afk-${iid}`;

    try {
      const { simpleGit } = await import('simple-git');
      const git = simpleGit();
      const branches = await git.branch(['-r']);
      const remoteBranch = branches.all.find(b => b.includes(expectedBranch));
      if (remoteBranch) return remoteBranch;

      // Fallback: check local branches
      const localBranches = await git.branch();
      const localBranch = localBranches.all.find(b => b.includes(expectedBranch));
      if (localBranch) return localBranch;
    } catch {
      // git operation failed, try other methods
    }

    // Try to find the branch from the MR
    try {
      const mrs = await this.tracker.listMRs({ state: 'opened' });
      const mr = mrs.find(m => m.title.includes(`#${iid}`) || m.sourceBranch.includes(expectedBranch));
      if (mr) return mr.sourceBranch;
    } catch {
      // tracker operation failed
    }

    return null;
  }

  /**
   * Merge a feature branch into the current worktree.
   */
  private async mergeBranch(worktreePath: string, branch: string): Promise<void> {
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(worktreePath);

    // Fetch the branch first
    try {
      await git.fetch('origin', branch);
    } catch {
      // branch may be local only
    }

    try {
      await git.merge([branch]);
    } catch (err) {
      await this.tracker.addComment(
        parseInt(worktreePath.split('-').pop() || '0', 10),
        `<!-- afk-event: qa-merge-conflict -->\n**❌ QA Merge Conflict**\n\nMerge of \`${branch}\` failed. Manual resolution required.`
      );
      throw err;
    }

    logger.info({ worktreePath, branch }, 'branch merged successfully');
  }

  /**
   * Handle AC result signal.
   */
  private async handleACResult(
    iid: number,
    _worktreePath: string,
    session: string,
    signal: { type: string; summary?: string; result?: string }
  ): Promise<{ success: boolean; mrUrl?: string }> {
    await this.tmux.killSession(session);

    // Find the MR for this issue
    const mrs = await this.tracker.listMRs({ state: 'opened' });
    const mr = mrs.find(m => m.title.includes(`#${iid}`));

    if (!mr) {
      await this.tracker.addComment(iid, '<!-- afk-event: qa-failed -->\n**❌ QA Failed**\n\nMR not found for this issue.');
      await this.tracker.addLabel(iid, 'mode::hitl');
      return { success: false };
    }

    // AC passed → merge MR
    try {
      await this.tracker.mergeMR(mr.id, {
        deleteSourceBranch: true,
        squash: true,
        mergeCommitMessage: `Merge QA verified: Resolve #${iid}`,
      });

      await this.tracker.addComment(iid, [
        '<!-- afk-event: qa-passed -->',
        '**✅ QA Passed**',
        '',
        `- **MR:** ${mr.url}`,
        signal.summary ? `- **Summary:** ${signal.summary}` : '',
      ].filter(Boolean).join('\n'));

      await this.tracker.removeLabel(iid, 'stage::qa');
      await this.tracker.addLabel(iid, 'stage::done');

      logger.info({ iid, mrId: mr.id }, 'QA passed, MR merged');
      return { success: true, mrUrl: mr.url };

    } catch (err) {
      await this.tracker.addComment(iid, `<!-- afk-event: qa-failed -->\n**❌ QA Failed**\n\nMR merge failed: ${(err as Error).message}`);
      await this.tracker.addLabel(iid, 'mode::hitl');
      return { success: false };
    }
  }

  /**
   * Handle QA timeout.
   */
  private async handleTimeout(
    iid: number,
    worktreePath: string,
    session: string
  ): Promise<{ success: boolean }> {
    const snapshot = await this.tmux.capturePane(session, 'main', { lines: 100, history: 200 });
    const logPath = `${this.logDir}/timeout-${iid}-${Date.now()}.log`;

    await (await import('fs')).promises.mkdir(this.logDir, { recursive: true });
    await (await import('fs')).promises.writeFile(logPath, snapshot, 'utf-8');

    await this.tracker.addComment(iid, `<!-- afk-event: qa-timeout -->
**⏱️ QA Timeout**

Session exceeded timeout and was force killed.

- **Log:** \`${logPath}\`

**Recovery:** Remove \`mode::hitl\` label and re-trigger QA.`);

    await this.tracker.addLabel(iid, 'mode::hitl');
    await this.tmux.killSession(session);
    await this.worktree.updateStatus(iid, 'failed');

    return { success: false };
  }
}