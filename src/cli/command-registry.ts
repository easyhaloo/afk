import { Command } from 'commander';
import { AFK_VERSION } from '@afk/application';
import type { CliRuntimePorts } from './composition-root.js';
import { createCliRuntimePorts } from './composition-root.js';

export interface CommandRegistrationContext {
  /** The argv the command parses, when the caller has one of its own. */
  argv?: readonly string[];
  /**
   * The runtime the command is driven through.
   *
   * A command is a driver: it turns what the user asked for into a call
   * on a use case. It does not know how the configuration file is read or
   * which class talks to tmux - the composition root does, and hands the
   * result over here.
   */
  ports: CliRuntimePorts;
}

export type RegisterFn = (p: Command, context: CommandRegistrationContext) => void;

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
  { names: ['kanban'], loader: () => import('./commands/kanban.js').then(m => m.registerKanbanCommands) },
  { names: ['debug'], loader: () => import('./commands/debug.js').then(m => m.registerDebugCommands) },
  { names: ['isolate'], loader: () => import('./commands/isolate.js').then(m => m.registerIsolateCommands) },
  { names: ['backlog'], loader: () => import('./commands/backlog.js').then(m => m.registerBacklogCommands) },
  { names: ['run'], loader: () => import('./commands/run.js').then(m => m.registerRunCommands) },
  { names: ['execute', 'reconcile'], loader: () => import('./commands/execute.js').then(m => m.registerExecuteCommands) },
  { names: ['qa'], loader: () => import('./commands/qa.js').then(m => m.registerQACommands) },
  { names: ['loop'], loader: () => import('./commands/loop.js').then(m => m.registerLoopCommands) },
  { names: ['observe'], loader: () => import('./commands/observe.js').then(m => m.registerObserveCommands) },
  { names: ['retro'], loader: () => import('./commands/retro.js').then(m => m.registerRetroCommands) },
  { names: ['graph'], loader: () => import('./commands/graph.js').then(m => m.registerGraphCommands) },
  { names: ['completion', '__complete'], loader: () => import('./commands/completion.js').then(m => m.registerCompletionCommands) },
];

/**
 * A program with every command registered.
 *
 * The full CLI and the completion tree both need one, and a command that
 * one of them knows about and the other does not is a command the product
 * only half offers: the completion tree used to carry its own list, and it
 * had already fallen behind - `execute`, `reconcile`, `retro` and
 * `completion` were missing from the shell completion while the registry
 * and the documentation both offered them.
 */
export async function buildCommandProgram(): Promise<Command> {
  const program = new Command();
  program.name('afk').version(AFK_VERSION);
  const ports = await createCliRuntimePorts();
  const registerFns = await Promise.all(COMMANDS.map(command => command.loader()));
  for (const register of registerFns) register(program, { ports });
  return program;
}
