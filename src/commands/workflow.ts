import { Command } from 'commander';
import { handleCommandError } from '../lib/cli-utils';
import { runWorkflowCli } from '../lib/workflows/run-cmd';
import { getWorkflowConfig } from '../lib/core/config/manager';
import type { BranchStrategyConfig } from '../lib/branches/types';

function parseBranchStrategy(raw: string): BranchStrategyConfig {
  const colon = raw.indexOf(':');
  if (colon < 0) throw new Error(`invalid branch-strategy format: ${raw}`);
  const type = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);

  switch (type) {
    case 'issue':
      return { type: 'issue', iid: parseInt(rest, 10) };
    case 'named':
      return { type: 'named', branch: rest };
    case 'merge-to-head':
      return { type: 'merge-to-head' };
    case 'existing':
      return { type: 'existing', branch: rest };
    default:
      throw new Error(`unknown branch-strategy type: ${type}; expected issue, named, merge-to-head, existing`);
  }
}

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
    .option('--max-retries <n>', 'Max retry attempts', parseInt)
    .option('--hard-timeout <ms>', 'Hard timeout in ms')
    .option('--max-handoffs <n>', 'Max automatic context-handoff rounds')
    .option('--context-high <tokens>', 'Token threshold that triggers context handoff')
    .option('--max-total-tokens <tokens>', 'Max total tokens across handoff generations')
    .option('--ext <modules...>', 'Lifecycle modules to activate (e.g., isolate)')
    .option('--ext-param <params...>', 'Module parameters (e.g., isolate.auto=true)')
    .option('--sandbox <provider>', 'Sandbox provider: local | docker | podman (default: local)')
    .option('--agent <name>', 'Agent provider: claude-code | codex | cursor | pi | opencode | copilot (default: claude-code)')
    .option('--branch-strategy <config>', 'Branch strategy: issue:<iid> | named:<branch> | merge-to-head | existing:<branch>')
    .option('--template <name>', 'Workflow template name (e.g., issue-implementation, simple-loop)')
    .action(async (options) => {
      try {
        const cfg = getWorkflowConfig();
        const goalBudget = cfg.goalBudget || 500_000;
        await runWorkflowCli({
          iid: options.iid,
          session: options.session,
          targetBranch: options.targetBranch ?? 'main',
          baseBranch: options.baseBranch ?? 'main',
          maxRetries: options.maxRetries ?? cfg.maxRetries,
          hardTimeoutMs: options.hardTimeout ?? cfg.workflowHardTimeout,
          maxHandoffs: options.maxHandoffs ?? (Math.min(Math.ceil(goalBudget / 1_000_000), 20) || 3),
          contextHighTokens: options.contextHigh ?? cfg.contextThreshold,
          maxTotalTokens: options.maxTotalTokens ?? goalBudget,
          ext: options.ext,
          extParams: options.extParam,
          sandboxProvider: options.sandbox as any,
          agentProvider: options.agent as any,
          branchStrategy: options.branchStrategy ? parseBranchStrategy(options.branchStrategy) : undefined,
          template: options.template,
        });
      } catch (error) {
        handleCommandError(error);
      }
    });
}
