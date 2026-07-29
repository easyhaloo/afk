/**
 * Full CLI — loads all command modules.
 * Fallback for: no args, unknown commands.
 */
import { Command } from 'commander';
// Logger auto-initializes on import (creates ~/.afk/ dir, suppresses Octokit warnings)
import './lib/core/io/logger';
import { registerSignalCommands } from './commands/signal';
import { registerGitLabCommands } from './commands/gitlab';
import { registerGitHubCommands } from './commands/github';
import { registerTrackerCommands } from './commands/tracker';
import { registerTmuxCommands } from './commands/tmux';
import { registerWorktreeCommands } from './commands/worktree';
import { registerWorkflowCommands } from './commands/workflow';
import { registerSchedulerCommands } from './commands/scheduler';
import { registerDashboardCommands } from './commands/dashboard';
import { registerDbCommands } from './commands/db';
import { registerDebugCommands } from './commands/debug';
import { registerEscalateCommands } from './commands/escalate';
import { registerForkCommands } from './commands/fork';
import { registerQACommands } from './commands/qa';

export function runFullCLI() {
  const program = new Command();
  program.name('afk').version('0.1.0');
  registerSignalCommands(program);
  registerTrackerCommands(program);
  registerGitLabCommands(program);
  registerGitHubCommands(program);
  registerTmuxCommands(program);
  registerWorktreeCommands(program);
  registerWorkflowCommands(program);
  registerSchedulerCommands(program);
  registerDashboardCommands(program);
  registerDbCommands(program);
  registerDebugCommands(program);
  registerEscalateCommands(program);
  registerForkCommands(program);
  registerQACommands(program);
  program.parse();
}
