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
  [['loop'], () => import('./commands/loop.js')],
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

      // Parse on the command that owns the remaining args. Commander 12
      // routes multi-level subcommands poorly from a synthetic argv on the
      // top-level program, and its parse() always slices argv[0..1]
      // (node + script) off whatever it receives — so give it the synthetic
      // ['afk', cmd, ...] and commander slices down to exactly the user's
      // remaining args.
      //
      // Parsing on the matched command instead of the top-level program also
      // makes bare `afk loop` run loop's action: an empty remaining-args
      // parse invokes the command's action when it has one, whereas the
      // top-level program has no action and would print its help.
      const matched = program.commands.find(c => c.name() === cmd);
      if (matched) {
        const sub = matched.commands.find(c => c.name() === extraArgs[0]);
        const target = sub ?? matched;
        target.parse(['afk', cmd, ...extraArgs]);
        return;
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
