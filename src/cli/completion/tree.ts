import { Command } from 'commander';
import { registerSignalCommands } from '../commands/signal';
import { registerTmuxCommands } from '../commands/tmux';
import { registerKanbanCommands } from '../commands/kanban';
import { registerDebugCommands } from '../commands/debug';
import { registerIsolateCommands } from '../../application/isolate';
import { registerQACommands } from '../commands/qa';
import { registerLoopCommands } from '../commands/loop';
import { registerBacklogCommands } from '../commands/backlog';
import { registerRunCommands } from '../commands/run';

export function buildCompletionTree(): Command {
  const program = new Command();
  program.name('afk');
  registerSignalCommands(program);
  registerTmuxCommands(program);
  registerKanbanCommands(program);
  registerDebugCommands(program);
  registerIsolateCommands(program);
  registerQACommands(program);
  registerLoopCommands(program);
  registerBacklogCommands(program);
  registerRunCommands(program);
  return program;
}
