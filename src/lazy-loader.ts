/**
 * Lazy-loads command modules for all non-board commands.
 */
import { Command } from 'commander';

type RegisterFn = (p: Command) => void;

const LOADER: [string[], () => Promise<{ [k: string]: RegisterFn }>][] = [
  [['signal'], () => import('./commands/signal.js')],
  [['gitlab'], () => import('./commands/gitlab.js')],
  [['tmux'], () => import('./commands/tmux.js')],
  [['worktree'], () => import('./commands/worktree.js')],
  [['workflow'], () => import('./commands/workflow.js')],
  [['scheduler'], () => import('./commands/scheduler.js')],
  [['board'], () => import('./commands/board.js')],
  [['db'], () => import('./commands/db.js')],
  [['debug'], () => import('./commands/debug.js')],
  [['escalate'], () => import('./commands/escalate.js')],
  [['fork'], () => import('./commands/fork.js')],
  [['qa'], () => import('./commands/qa.js')],
];

export async function lazyLoad(cmd: string, extraArgs: string[]) {
  for (const [names, loader] of LOADER) {
    if (!names.includes(cmd)) continue;

    try {
      const mod = await loader();
      const register = Object.values(mod)[0] as RegisterFn;
      const program = new Command();
      program.name('afk').version('0.1.0').exitOverride();
      register(program);

      // For subcommand trees (e.g. "scheduler run"), use the matched
      // subcommand to parse the remaining process.argv. Commander 12 has a
      // known issue routing multi-level subcommands when program.parse()
      // is called with a synthetic argv, so we use the subcommand's own
      // parse() with the real argv instead.
      const matched = program.commands.find(c => c.name() === cmd);
      if (matched && matched.commands.length > 0 && extraArgs.length > 0) {
        const sub = matched.commands.find(c => c.name() === extraArgs[0]);
        if (sub) {
          // Strip the first 2 elements (node + script) from process.argv
          // so the subcommand parses from the correct position.
          const argv = process.argv.slice(2);
          sub.parse(argv);
          return;
        }
      }
      program.parse(['afk', cmd, ...extraArgs]);
      return;
    } catch (err: unknown) {
      // With exitOverride(), Commander throws CommanderError instead of calling
      // process.exit(). Re-throw so index.ts's .catch() handles it; this avoids
      // calling process.exit() directly which would trigger on-exit-leak-free
      // handlers before the logger is fully initialized.
      throw err;
    }
  }
  // Unknown command → full CLI
  const { runFullCLI } = await import('./full-cli.js');
  runFullCLI();
}
