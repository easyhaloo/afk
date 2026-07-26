import { Command } from 'commander';
import chalk from 'chalk';
import { GitLabClient } from '../lib/gitlab.js';
import { WorkflowOrchestrator } from '../lib/workflow.js';
import { WorkflowRunner } from '../lib/workflow-runner.js';

export function registerWorkflowCommands(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('High-level workflow orchestration');

  /**
   * launch command
   */
  workflow
    .command('launch')
    .description('Launch complete workflow: worktree → session → goal → wait')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .option('--branch <branch>', 'Base branch', 'main')
    .option('--session <name>', 'Session name (default: afk-{iid})')
    .option('--timeout <ms>', 'Timeout in milliseconds', '7200000')
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const orchestrator = new WorkflowOrchestrator(gitlab);

        const result = await orchestrator.launch({
          iid: options.iid,
          baseBranch: options.branch,
          sessionName: options.session,
          timeout: parseInt(options.timeout),
        });

        if (result.success) {
          console.log(chalk.green('\n✅ Workflow completed successfully!'));
          process.exit(0);
        } else {
          console.log(chalk.yellow('\n⚠️  Workflow timed out'));
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red('\n❌ Workflow failed:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * run command — signal-driven workflow using WorkflowRunner
   */
  workflow
    .command('run')
    .description('Signal-driven workflow: launch tmux → wait signals → autoWrapup → MR')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .option('--session <name>', 'Session name (default: afk-{iid})')
    .option('--target-branch <branch>', 'Target branch for MR', 'main')
    .option('--base-branch <branch>', 'Base branch for worktree', 'main')
    .option('--max-retries <n>', 'Max retry attempts', parseInt, 3)
    .option('--hard-timeout <ms>', 'Hard timeout in ms (default: 7200000)', parseInt, 7200000)
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const runner = new WorkflowRunner(gitlab);

        const session = options.session || `afk-${options.iid}`;
        const result = await runner.run({
          iid: options.iid,
          session,
          targetBranch: options.targetBranch,
          baseBranch: options.baseBranch,
          maxRetries: options.maxRetries,
          hardTimeoutMs: options.hardTimeout,
        });

        if (result.success) {
          console.log(chalk.green('\n✅ Workflow completed!'));
          if (result.url) {
            console.log(chalk.cyan(`   MR: ${result.url}`));
          }
          process.exit(0);
        } else {
          console.log(chalk.yellow('\n⚠️  Workflow did not complete successfully'));
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red('\n❌ Workflow failed:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * run-ac command
   */
  workflow
    .command('run-ac')
    .description('Run acceptance criteria checks')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .requiredOption('--session <name>', 'Session name')
    .requiredOption('--dir <path>', 'Worktree directory')
    .option('--window <name>', 'Window name', 'main')
    .option('--timeout <ms>', 'Timeout in milliseconds', '180000')
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const orchestrator = new WorkflowOrchestrator(gitlab);

        const result = await orchestrator.runAC({
          iid: options.iid,
          session: options.session,
          window: options.window,
          worktreeDir: options.dir,
          timeout: parseInt(options.timeout),
        });

        if (result.result === 'PASS') {
          console.log(chalk.green('\n✅ AC checks passed!'));
          process.exit(0);
        } else {
          console.log(chalk.red('\n❌ AC checks failed'));
          process.exit(1);
        }
      } catch (error) {
        console.error(chalk.red('\n❌ AC check failed:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * create-mr command
   */
  workflow
    .command('create-mr')
    .description('Create merge request')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .requiredOption('--dir <path>', 'Worktree directory')
    .option('--target-branch <branch>', 'Target branch', 'main')
    .option('--auto-merge', 'Enable auto-merge', false)
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const orchestrator = new WorkflowOrchestrator(gitlab);

        const result = await orchestrator.createMR({
          iid: options.iid,
          worktreeDir: options.dir,
          targetBranch: options.targetBranch,
          autoMerge: options.autoMerge,
        });

        console.log(chalk.green('\n✅ Merge request created!'));
        console.log(chalk.cyan(`   ${result.url}`));
        process.exit(0);
      } catch (error) {
        console.error(chalk.red('\n❌ MR creation failed:'), (error as Error).message);
        process.exit(1);
      }
    });

  /**
   * status command
   */
  workflow
    .command('status')
    .description('Check workflow status for issue')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .action(async (options) => {
      try {
        const gitlab = createGitLabClient();
        const { WorktreeManager } = await import('../lib/worktree.js');
        const { TmuxClient } = await import('../lib/tmux.js');

        const manager = new WorktreeManager();
        const tmux = new TmuxClient();

        // Get worktree
        const worktree = await manager.get(options.iid);

        console.log(chalk.bold(`\nWorkflow status for issue #${options.iid}:`));
        console.log();

        if (!worktree) {
          console.log(chalk.yellow('  No worktree found'));
          process.exit(0);
        }

        console.log(chalk.gray(`  Worktree: ${worktree.path}`));
        console.log(chalk.gray(`  Branch: ${worktree.branch}`));
        console.log(chalk.gray(`  Status: ${worktree.status}`));
        console.log(chalk.gray(`  Created: ${worktree.createdAt.toISOString()}`));

        if (worktree.sessionId) {
          const hasSession = await tmux.hasSession(worktree.sessionId);
          console.log(chalk.gray(`  Session: ${worktree.sessionId} ${hasSession ? chalk.green('(active)') : chalk.red('(not found)')}`));
        }

        // Check for signal file
        const { readSignal } = await import('../lib/io.js');
        const signal = await readSignal(worktree.path);

        if (signal) {
          console.log();
          console.log(chalk.bold('  Latest signal:'));
          console.log(chalk.gray(`    Type: ${signal.type}`));
          console.log(chalk.gray(`    Timestamp: ${signal.timestamp}`));
          console.log(chalk.gray(`    Summary: ${(signal as any).summary ?? ''}`));
        }
      } catch (error) {
        console.error(chalk.red('Error:'), (error as Error).message);
        process.exit(1);
      }
    });
}

/**
 * Create GitLab client from environment variables
 */
function createGitLabClient(): GitLabClient {
  const url = process.env.GITLAB_URL || 'https://gitlab.com';
  const token = process.env.GITLAB_TOKEN;
  const projectId = process.env.GITLAB_PROJECT_ID;

  if (!token) {
    throw new Error('GITLAB_TOKEN environment variable is required');
  }

  if (!projectId) {
    throw new Error('GITLAB_PROJECT_ID environment variable is required');
  }

  return new GitLabClient({ url, token, projectId });
}
