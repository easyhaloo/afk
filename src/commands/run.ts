import { Command, InvalidArgumentError } from 'commander';
import { handleCommandError, success, warning, detail } from '../lib/cli-utils';
import { runWorkflowCli } from '../lib/workflows/run-cmd';
import { getWorkflowConfig } from '../lib/core/config/manager';

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError(`expected a positive integer, got '${value}'`);
  }
  return parsed;
}
export function registerRunCommands(program: Command): void {
  program
    .command('run')
    .description('Claim and execute one backlog item')
    .requiredOption('--backlog-id <id>', 'Backlog ID')
    .option('--session <name>', 'Execution session name (default: afk-<backlog-id>)')
    .option('--project <project>', 'Provider project/repository')
    .option('--target-branch <branch>', 'Target branch for the change')
    .option('--base-branch <branch>', 'Base branch for the worktree')
    .option('--max-retries <n>', 'Maximum retry attempts', positiveInt)
    .option('--hard-timeout <ms>', 'Hard timeout in milliseconds', positiveInt)
    .option('--max-handoffs <n>', 'Maximum context-handoff rounds', positiveInt)
    .option('--context-high <tokens>', 'Context token threshold', positiveInt)
    .option('--max-total-tokens <tokens>', 'Maximum total tokens', positiveInt)
    .option('--ext <modules...>', 'Lifecycle modules to activate')
    .option('--ext-param <params...>', 'Lifecycle module parameters')
    .option('--sandbox <provider>', 'Sandbox provider: local | docker | podman')
    .option('--agent <name>', 'Agent provider')
    .option('--execution-mode <mode>', 'Agent execution mode: interactive | batch')
    .option('--template <name>', 'Workflow template name')
    .action(async options => {
      try {
        const cfg = getWorkflowConfig();
        const goalBudget = cfg.goalBudget || 500_000;
        const result = await runWorkflowCli({
          backlogId: options.backlogId,
          session: options.session,
          projectName: options.project,
          targetBranch: options.targetBranch,
          baseBranch: options.baseBranch,
          maxRetries: options.maxRetries ?? cfg.maxRetries,
          hardTimeoutMs: options.hardTimeout ?? cfg.workflowHardTimeout,
          maxHandoffs: options.maxHandoffs ?? (Math.min(Math.ceil(goalBudget / 1_000_000), 20) || 3),
          contextHighTokens: options.contextHigh ?? cfg.contextThreshold,
          maxTotalTokens: options.maxTotalTokens ?? goalBudget,
          ext: options.ext,
          extParams: options.extParam,
          sandboxProvider: options.sandbox,
          agentProvider: options.agent,
          executionMode: options.executionMode,
          template: options.template,
        });
        if (!result.success) {
          warning('Backlog execution did not complete successfully');
          process.exitCode = 1;
          return;
        }
        success('Backlog execution completed');
        if (result.url) detail(`Change: ${result.url}`);
      } catch (error) {
        handleCommandError(error);
      }
    });
}
