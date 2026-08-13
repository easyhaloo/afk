import { Command } from 'commander';
import { registerSignalCommands } from '../../cli/commands/signal';
import { registerTmuxCommands } from '../../cli/commands/tmux';
import { registerKanbanCommands } from '../../cli/commands/kanban';
import { registerDebugCommands } from '../../cli/commands/debug';
import { registerIsolateCommands } from '../../application/isolate';
import { registerQACommands } from '../../cli/commands/qa';
import { registerLoopCommands } from '../../cli/commands/loop';
import { registerBacklogCommands } from '../../cli/commands/backlog';
import { registerRunCommands } from '../../cli/commands/run';

/**
 * Build a commander tree containing every completable command, for completion
 * introspection. This is the single source of truth for completion data -
 * no separate manifest to drift from.
 *
 * `board` is intentionally NOT registered: `afk board` is rejected by the
 * dispatcher (use bare `afk`), and importing board.ts would pull Ink/React
 * into the completion path for no benefit.
 *
 * Unlike full-cli.ts this does not run `import './lib/core/io/logger'`. The
 * logger is still pulled in transitively via cli-utils (used by command
 * modules), but its disk writes are lazy (silent in NODE_ENV=test), so
 * importing this tree never touches disk. `afk completion` is an infrequent
 * command; the per-tab `__complete` path does not import this tree at all
 * while dynamic completion is unimplemented.
 */
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
