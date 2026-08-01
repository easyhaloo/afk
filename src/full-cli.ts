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
import { registerBoardCommands } from './commands/board';
import { registerKanbanCommands } from './commands/kanban';
import { registerDebugCommands } from './commands/debug';
import { registerEscalateCommands } from './commands/escalate';
import { registerIsolateCommands } from './commands/isolate';
import { registerQACommands } from './commands/qa';
import { registerLoopCommands } from './commands/loop';
import { registerCompletionCommands } from './commands/completion';

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
  registerBoardCommands(program);
  registerKanbanCommands(program);
    registerDebugCommands(program);
  registerEscalateCommands(program);
  registerIsolateCommands(program);
  registerQACommands(program);
  registerLoopCommands(program);
  registerCompletionCommands(program);
  program.parse();
}
