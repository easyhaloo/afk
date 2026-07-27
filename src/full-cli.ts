/**
 * Full CLI — loads all command modules.
 * Fallback for: no args, unknown commands.
 */
import { Command } from 'commander';
import { registerSignalCommands } from './commands/signal.js';
import { registerGitLabCommands } from './commands/gitlab.js';
import { registerTmuxCommands } from './commands/tmux.js';
import { registerWorktreeCommands } from './commands/worktree.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { registerSchedulerCommands } from './commands/scheduler.js';
import { registerDashboardCommands } from './commands/dashboard.js';
import { registerDbCommands } from './commands/db.js';
import { registerDebugCommands } from './commands/debug.js';
import { registerEscalateCommands } from './commands/escalate.js';
import { registerForkCommands } from './commands/fork.js';

export function runFullCLI() {
  const program = new Command();
  program.name('afk').version('0.1.0');
  registerSignalCommands(program);
  registerGitLabCommands(program);
  registerTmuxCommands(program);
  registerWorktreeCommands(program);
  registerWorkflowCommands(program);
  registerSchedulerCommands(program);
  registerDashboardCommands(program);
  registerDbCommands(program);
  registerDebugCommands(program);
  registerEscalateCommands(program);
  registerForkCommands(program);
  program.parse();
}
