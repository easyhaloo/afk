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
  // tracker.ts registers flat `issue` + `mr` commands (no `tracker` parent).
  { names: ['issue', 'mr'], loader: () => import('./commands/tracker.js').then(m => m.registerTrackerCommands) },
  { names: ['gitlab'], loader: () => import('./commands/gitlab.js').then(m => m.registerGitLabCommands) },
  { names: ['github'], loader: () => import('./commands/github.js').then(m => m.registerGitHubCommands) },
  { names: ['tmux'], loader: () => import('./commands/tmux.js').then(m => m.registerTmuxCommands) },
  { names: ['worktree'], loader: () => import('./commands/worktree.js').then(m => m.registerWorktreeCommands) },
  { names: ['workflow'], loader: () => import('./commands/workflow.js').then(m => m.registerWorkflowCommands) },
  { names: ['scheduler'], loader: () => import('./commands/scheduler.js').then(m => m.registerSchedulerCommands) },
  { names: ['board'], loader: () => import('./commands/board.js').then(m => m.registerBoardCommands) },
  { names: ['kanban'], loader: () => import('./commands/kanban.js').then(m => m.registerKanbanCommands) },
  { names: ['debug'], loader: () => import('./commands/debug.js').then(m => m.registerDebugCommands) },
  { names: ['escalate'], loader: () => import('./commands/escalate.js').then(m => m.registerEscalateCommands) },
  { names: ['isolate'], loader: () => import('./commands/isolate.js').then(m => m.registerIsolateCommands) },
  { names: ['qa'], loader: () => import('./commands/qa.js').then(m => m.registerQACommands) },
  { names: ['loop'], loader: () => import('./commands/loop.js').then(m => m.registerLoopCommands) },
  { names: ['completion', '__complete'], loader: () => import('./commands/completion.js').then(m => m.registerCompletionCommands) },
];
