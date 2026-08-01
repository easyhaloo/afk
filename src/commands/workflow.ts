import { Command } from 'commander';
import { createTrackerClient } from '../lib/client-factory';
import { WorkflowRunner } from '../lib/workflows';
import { getWorkflowConfig } from '../lib/config-manager';
import { TIMEOUTS, CONTEXT, MAX_HANDOFFS, MAX_TOTAL_TOKENS } from '../lib/constants';
import { handleCommandError, success, warning, detail } from '../lib/cli-utils';

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
    .option('--max-handoffs <n>', 'Max automatic context-handoff rounds (default: 3)', parseInt, MAX_HANDOFFS)
    .option('--context-high <tokens>', 'Token threshold that triggers context handoff (default: 100000)', parseInt, CONTEXT.HIGH_THRESHOLD)
    .option('--max-total-tokens <tokens>', 'Max total tokens across handoff generations (default: 500000)', parseInt, MAX_TOTAL_TOKENS)
    .option('--ext <modules...>', 'Lifecycle modules to activate (e.g., isolate)')
    .option('--ext-param <params...>', 'Module parameters (e.g., isolate.auto=true)')
    .action(async (options) => {
      try {
        const tracker = await createTrackerClient();
        const runner = new WorkflowRunner(tracker);

        const cfg = getWorkflowConfig();
        const session = options.session || `afk-${options.iid}`;
        const result = await runner.run({
          iid: options.iid,
          session,
          targetBranch: options.targetBranch ?? cfg.targetBranch,
          baseBranch: options.baseBranch,
          maxRetries: options.maxRetries ?? cfg.maxRetries,
          hardTimeoutMs: options.hardTimeout ?? cfg.completionTimeout,
          maxHandoffs: options.maxHandoffs,
          contextHighTokens: options.contextHigh,
          maxTotalTokens: options.maxTotalTokens,
          ext: options.ext,
          extParams: options.extParam,
        });

        if (result.success) {
          success('Workflow completed!');
          if (result.url) {
            detail(`MR: ${result.url}`);
          }
          process.exit(0);
        } else {
          warning('Workflow did not complete successfully');
          process.exit(1);
        }
      } catch (error) {
        handleCommandError(error);
      }
    });
}
