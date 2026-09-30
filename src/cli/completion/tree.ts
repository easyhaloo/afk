import { Command } from 'commander';
import { registerSignalCommands } from '../commands/signal.js';
import { registerTmuxCommands } from '../commands/tmux.js';
import { registerKanbanCommands } from '../commands/kanban.js';
import { registerDebugCommands } from '../commands/debug.js';
import { registerIsolateCommands } from '../commands/isolate.js';
import { registerQACommands } from '../commands/qa.js';
import { registerLoopCommands } from '../commands/loop.js';
import { registerBacklogCommands } from '../commands/backlog.js';
import { registerRunCommands } from '../commands/run.js';
import { registerGraphCommands } from '../commands/graph.js';
import { registerObserveCommands } from '../commands/observe.js';

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
  registerGraphCommands(program);
  registerObserveCommands(program);
  return program;
}
