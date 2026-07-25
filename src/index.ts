#!/usr/bin/env node
import { Command } from 'commander';
import { registerSignalCommands } from './commands/signal.js';
import { registerGitLabCommands } from './commands/gitlab.js';
import { registerTmuxCommands } from './commands/tmux.js';
import { registerWorktreeCommands } from './commands/worktree.js';
import { registerWorkflowCommands } from './commands/workflow.js';
import { registerSchedulerCommands } from './commands/scheduler.js';
import { registerDashboardCommands } from './commands/dashboard.js';

const program = new Command();

program
  .name('afk')
  .description('Unified CLI for AFK (Automated Feature Kitchen) workflow')
  .version('0.1.0');

// Register command modules
registerSignalCommands(program);
registerGitLabCommands(program);
registerTmuxCommands(program);
registerWorktreeCommands(program);
registerWorkflowCommands(program);
registerSchedulerCommands(program);
registerDashboardCommands(program);

// Parse CLI arguments
program.parse();
