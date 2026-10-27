import { Command } from 'commander';

export interface CommandRegistrationContext {
  argv?: readonly string[];
}

export type RegisterFn = (p: Command, context?: CommandRegistrationContext) => void;

export interface CommandEntry {
  /** Public command names and aliases handled by this loader. */
  names: string[];
  /** Dynamically imports the module that registers this command. */
  loader: () => Promise<RegisterFn>;
}

/**
 * Single source of truth for command names, aliases, and lazy registration.
 * The dispatcher lives here so the registry and the only supported dispatch
 * path cannot drift apart.
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
  { names: ['observe', 'log'], loader: () => import('./commands/observe.js').then(m => m.registerObserveCommands) },
  { names: ['retro'], loader: () => import('./commands/retro.js').then(m => m.registerRetroCommands) },
  { names: ['graph'], loader: () => import('./commands/graph.js').then(m => m.registerGraphCommands) },
  { names: ['completion', '__complete'], loader: () => import('./commands/completion.js').then(m => m.registerCompletionCommands) },
];

/** Build the argv expected by Commander when parsing a matched nested command. */
export function buildCommandArgv(command: string, args: string[], subcommand?: string): string[] {
  return subcommand
    ? ['afk', subcommand, ...args.slice(1)]
    : ['afk', command, ...args];
}

/** Load and parse exactly one registered command; unknown commands fail directly. */
export async function dispatchCommand(command: string, args: string[]): Promise<void> {
  if (command === '--help' || command === '-h') {
    const program = new Command();
    program.name('afk').version('0.1.0').exitOverride();
    const registrations = await Promise.all(COMMANDS.map(entry => entry.loader()));
    for (const register of registrations) register(program);
    await program.parseAsync(['node', 'afk', command, ...args]);
    return;
  }

  const entry = COMMANDS.find(candidate => candidate.names.includes(command));
  if (!entry) {
    throw new Error(`Unknown command '${command}'. Run 'afk --help' to see available commands.`);
  }

  const register = await entry.loader();
  const program = new Command();
  program.name('afk').version('0.1.0').exitOverride();
  register(program, { argv: ['node', 'afk', command, ...args] });

  const matched = program.commands.find(candidate => candidate.name() === command);
  if (!matched) {
    await program.parseAsync(['afk', command, ...args]);
    return;
  }

  const subcommand = matched.commands.find(candidate => candidate.name() === args[0]);
  const target = subcommand ?? matched;
  await target.parseAsync(buildCommandArgv(command, args, subcommand?.name()));
}
