import { Command } from 'commander';
import { TIMEOUTS, CONTEXT, MAX_HANDOFFS, MAX_TOTAL_TOKENS } from '../lib/constants';
import { handleCommandError } from '../lib/cli-utils';
import { runWorkflowCli } from '../lib/workflows/run-cmd';

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
        await runWorkflowCli({
          iid: options.iid,
          session: options.session,
          targetBranch: options.targetBranch,
          baseBranch: options.baseBranch,
          maxRetries: options.maxRetries,
          hardTimeoutMs: options.hardTimeout,
          maxHandoffs: options.maxHandoffs,
          contextHighTokens: options.contextHigh,
          maxTotalTokens: options.maxTotalTokens,
          ext: options.ext,
          extParams: options.extParam,
        });
      } catch (error) {
        handleCommandError(error);
      }
    });
}