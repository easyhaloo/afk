import type { Command } from 'commander';

type RegisterFn = (p: Command) => void;

export interface CommandEntry {
  /** Command name(s) that route to this loader. Hidden aliases (e.g. __complete) go here too. */
  names: string[];
  /** Dynamic import returning the register function. */
  loader: () => Promise<RegisterFn>;
}

/**
 * Single source of truth for CLI commands. Both the lazy loader (per-command
 * dynamic import - the fast path) and full-cli (load-all fallback) consume
 * this list, so the two can't drift: a command added here is present in both
 * paths. Previously the lazy loader's array and full-cli's register calls were
 * maintained separately, and `github` / `tracker` / `kanban` had silently
 * fallen out of the lazy list (always hitting the full load).
 */
export const COMMANDS: CommandEntry[] = [
  { names: ['signal'], loader: () => import('./commands/signal.js').then(m => m.registerSignalCommands) },
  { names: ['tmux'], loader: () => import('./commands/tmux.js').then(m => m.registerTmuxCommands) },
  { names: ['board'], loader: () => import('./commands/board.js').then(m => m.registerBoardCommands) },
  { names: ['kanban'], loader: () => import('./commands/kanban.js').then(m => m.registerKanbanCommands) },
  { names: ['debug'], loader: () => import('./commands/debug.js').then(m => m.registerDebugCommands) },
  { names: ['isolate'], loader: () => import('./commands/isolate.js').then(m => m.registerIsolateCommands) },
  { names: ['backlog'], loader: () => import('./commands/backlog.js').then(m => m.registerBacklogCommands) },
  { names: ['run'], loader: () => import('./commands/run.js').then(m => m.registerRunCommands) },
  { names: ['qa'], loader: () => import('./commands/qa.js').then(m => m.registerQACommands) },
  { names: ['loop'], loader: () => import('./commands/loop.js').then(m => m.registerLoopCommands) },
  { names: ['completion', '__complete'], loader: () => import('./commands/completion.js').then(m => m.registerCompletionCommands) },
];
