import { Command } from 'commander';
import chalk from 'chalk';
import { createGitLabClient } from '../lib/client-factory';
import { WorkflowRunner } from '../lib/workflows';
import { getWorkflowConfig } from '../lib/config-manager';
import { TIMEOUTS } from '../lib/constants';

export function registerWorkflowCommands(program: Command): void {
  const workflow = program
    .command('workflow')
    .description('Signal-driven workflow orchestration');

  /**
   * run — signal-driven workflow: launch tmux → wait signals → autoWrapup → MR
   */
  workflow
    .command('run')
    .description('Signal-driven workflow: launch tmux → wait signals → autoWrapup → MR')
    .requiredOption('--iid <iid>', 'Issue IID', parseInt)
    .option('--session <name>', 'Session name (default: afk-{iid})')
    .option('--target-branch <branch>', 'Target branch for MR', 'main')
    .option('--base-branch <branch>', 'Base branch for worktree', 'main')
    .option('--max-retries <n>', 'Max retry attempts', parseInt, 3)
    .option('--hard-timeout <ms>', 'Hard timeout in ms (default: 7200000)', parseInt, TIMEOUTS.WORKFLOW_HARD_TIMEOUT)
    .action(async (options) => {
      try {
        const gitlab = await createGitLabClient();
        const runner = new WorkflowRunner(gitlab);

        const cfg = getWorkflowConfig();
        const session = options.session || `afk-${options.iid}`;
        const result = await runner.run({
          iid: options.iid,
          session,
          targetBranch: options.targetBranch ?? cfg.targetBranch,
          baseBranch: options.baseBranch,
          maxRetries: options.maxRetries ?? cfg.maxRetries,
          hardTimeoutMs: options.hardTimeout ?? cfg.completionTimeout,
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
}
