import { GitLabClient } from './gitlab.js';
import { TmuxClient } from './tmux.js';
import { WorktreeManager } from './worktree.js';
import { readSignal } from './io.js';

export interface LaunchOptions {
  iid: number;
  baseBranch?: string;
  sessionName?: string;
  timeout?: number;
}

export interface ACRunOptions {
  iid: number;
  session: string;
  window?: string;
  worktreeDir: string;
  timeout?: number;
}

export interface MROptions {
  iid: number;
  worktreeDir: string;
  targetBranch?: string;
  autoMerge?: boolean;
}

/**
 * High-level workflow orchestration
 */
export class WorkflowOrchestrator {
  private gitlab: GitLabClient;
  private tmux: TmuxClient;
  private worktree: WorktreeManager;

  constructor(gitlab: GitLabClient) {
    this.gitlab = gitlab;
    this.tmux = new TmuxClient();
    this.worktree = new WorktreeManager();
  }

  /**
   * Launch complete workflow: worktree → session → goal → wait
   */
  async launch(options: LaunchOptions): Promise<{ success: boolean; signal?: any }> {
    const { iid, baseBranch = 'main', timeout = 7200000 } = options;
    const sessionName = options.sessionName || `afk-${iid}`;

    console.log(`\n🚀 Launching workflow for issue #${iid}...`);

    // Step 1: Get issue and parse AC
    console.log('\n📋 Step 1: Fetching issue from GitLab...');
    const issue = await this.gitlab.getIssue(iid);
    const ac = this.gitlab.parseAC(issue.description);

    if (!ac) {
      throw new Error(`Issue #${iid} has no AC section`);
    }

    console.log(`   Title: ${issue.title}`);
    console.log(`   AC items: ${ac.items.length}`);

    // Step 2: Create worktree
    console.log('\n📁 Step 2: Creating worktree...');
    const wt = await this.worktree.create(iid, baseBranch);
    console.log(`   Path: ${wt.path}`);
    console.log(`   Branch: ${wt.branch}`);

    try {
      // Step 3: Create tmux session
      console.log('\n🖥️  Step 3: Creating tmux session...');
      await this.tmux.createSession(sessionName, wt.path);
      console.log(`   Session: ${sessionName}`);

      // Step 4: Send goal
      console.log('\n🎯 Step 4: Sending /goal command...');
      const goalText = ac.items.map((item, i) => `${i + 1}. ${item}`).join('\n');
      await this.tmux.sendGoal(sessionName, 'main', goalText);
      console.log(`   Goal sent (${ac.items.length} items)`);

      // Step 5: Wait for completion
      console.log(`\n⏳ Step 5: Waiting for goal completion (timeout: ${timeout / 1000}s)...`);
      const signal = await this.tmux.waitForSignal(
        sessionName,
        'main',
        'goal_complete',
        wt.path,
        timeout
      );

      if (signal) {
        console.log('\n✅ Goal completed!');
        console.log(`   Summary: ${signal.summary}`);
        if (signal.type === 'goal_complete' && signal.sha) {
          console.log(`   SHA: ${signal.sha}`);
        }

        return { success: true, signal };
      } else {
        console.log('\n⚠️  Timeout waiting for goal completion');
        return { success: false };
      }
    } catch (error) {
      // Cleanup on error
      console.error('\n❌ Error during workflow:', (error as Error).message);

      try {
        await this.tmux.killSession(sessionName);
      } catch {
        // Ignore cleanup errors
      }

      throw error;
    }
  }

  /**
   * Run AC checks on completed goal
   */
  async runAC(options: ACRunOptions): Promise<{ result: 'PASS' | 'FAIL'; signal?: any }> {
    const { iid, session, window = 'main', worktreeDir, timeout = 180000 } = options;

    console.log(`\n🧪 Running AC checks for issue #${iid}...`);

    // Step 1: Get AC from issue
    console.log('\n📋 Step 1: Fetching AC from GitLab...');
    const issue = await this.gitlab.getIssue(iid);
    const ac = this.gitlab.parseAC(issue.description);

    if (!ac) {
      throw new Error(`Issue #${iid} has no AC section`);
    }

    console.log(`   AC items: ${ac.items.length}`);

    // Step 2: Send /resume with AC checks
    console.log('\n📝 Step 2: Sending AC check request...');

    const acPrompt = [
      '请运行以下验收条件（AC）检查，并创建结构化的检查报告：',
      '',
      ...ac.items.map((item, i) => `${i + 1}. ${item}`),
      '',
      '完成后请创建信号文件：',
      'afk signal ac-result --result PASS/FAIL --summary "<检查总结>"',
      '',
      '（或直接回复：AC_RESULT: PASS 或 AC_RESULT: FAIL）',
      '如果有代码变更，执行 git add -A && git commit',
    ].join('\n');

    // Send via tmux
    await this.tmux.sendKeys(session, window, ['/resume', acPrompt]);

    // Step 3: Wait for AC result signal
    console.log(`\n⏳ Step 3: Waiting for AC result (timeout: ${timeout / 1000}s)...`);
    const signal = await this.tmux.waitForSignal(
      session,
      window,
      'ac_result',
      worktreeDir,
      timeout
    );

    if (!signal) {
      console.log('\n⚠️  Timeout waiting for AC result');
      return { result: 'FAIL' };
    }

    if (signal.type !== 'ac_result') {
      console.log('\n⚠️  Unexpected signal type');
      return { result: 'FAIL' };
    }

    const result = signal.result;

    if (result === 'PASS') {
      console.log('\n✅ AC checks PASSED');
    } else {
      console.log('\n❌ AC checks FAILED');
    }

    console.log(`   Summary: ${signal.summary}`);

    return { result, signal };
  }

  /**
   * Create merge request
   */
  async createMR(options: MROptions): Promise<{ url: string }> {
    const { iid, worktreeDir, targetBranch = 'main', autoMerge = false } = options;

    console.log(`\n📤 Creating merge request for issue #${iid}...`);

    // Step 1: Get issue info
    const issue = await this.gitlab.getIssue(iid);
    const worktree = await this.worktree.get(iid);

    if (!worktree) {
      throw new Error(`Worktree for issue #${iid} not found`);
    }

    console.log(`   Source branch: ${worktree.branch}`);
    console.log(`   Target branch: ${targetBranch}`);

    // Step 2: Push branch
    console.log('\n⬆️  Step 2: Pushing branch to remote...');
    const { simpleGit } = await import('simple-git');
    const git = simpleGit(worktreeDir);

    await git.push('origin', worktree.branch, ['--set-upstream']);
    console.log('   Branch pushed');

    // Step 3: Create MR via glab (GitBeaker doesn't support MR creation easily)
    console.log('\n📋 Step 3: Creating merge request...');

    const title = `[#${iid}] ${issue.title}`;
    const description = [
      `Closes #${iid}`,
      '',
      '## Summary',
      issue.description.split('\n').slice(0, 5).join('\n'),
      '',
      '## Test Plan',
      '- [ ] All AC items verified',
      '- [ ] No regressions',
      '',
      '🤖 Generated with [afk CLI](https://github.com/afk)',
    ].join('\n');

    // Use glab CLI for now (GitBeaker MR API is complex)
    const { spawn } = await import('child_process');
    const glabArgs = [
      'mr', 'create',
      '--title', title,
      '--description', description,
      '--source-branch', worktree.branch,
      '--target-branch', targetBranch,
      '--remove-source-branch',
    ];

    if (autoMerge) {
      glabArgs.push('--squash-before-merge');
    }

    const proc = spawn('glab', glabArgs, {
      stdio: 'pipe',
      cwd: worktreeDir,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    await new Promise((resolve, reject) => {
      proc.on('close', (code) => {
        if (code === 0) {
          resolve(code);
        } else {
          reject(new Error(`glab mr create failed: ${stderr || stdout}`));
        }
      });
      proc.on('error', reject);
    });

    // Extract MR URL from output
    const urlMatch = stdout.match(/(https:\/\/[^\s]+)/);
    const url = urlMatch ? urlMatch[1] : '';

    console.log(`\n✅ Merge request created!`);
    console.log(`   URL: ${url}`);

    // Update worktree status
    await this.worktree.updateStatus(iid, 'completed');

    return { url };
  }
}
