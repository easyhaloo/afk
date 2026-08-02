import { Command } from 'commander';
import { registerSignalCommands } from '../../commands/signal';
import { registerTrackerCommands } from '../../commands/tracker';
import { registerTmuxCommands } from '../../commands/tmux';
import { registerWorktreeCommands } from '../../commands/worktree';
import { registerWorkflowCommands } from '../../commands/workflow';
import { registerSchedulerCommands } from '../../commands/scheduler';
import { registerKanbanCommands } from '../../commands/kanban';
import { registerDebugCommands } from '../../commands/debug';
import { registerEscalateCommands } from '../../commands/escalate';
import { registerIsolateCommands } from '../../commands/isolate';
import { registerQACommands } from '../../commands/qa';
import { registerLoopCommands } from '../../commands/loop';

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
  registerTrackerCommands(program);
  registerTmuxCommands(program);
  registerWorktreeCommands(program);
  registerWorkflowCommands(program);
  registerSchedulerCommands(program);
  registerKanbanCommands(program);
  registerDebugCommands(program);
  registerEscalateCommands(program);
  registerIsolateCommands(program);
  registerQACommands(program);
  registerLoopCommands(program);
  return program;
}
