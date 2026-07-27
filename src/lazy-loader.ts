/**
 * Lazy-loads command modules for all non-dashboard commands.
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
];

export async function lazyLoad(cmd: string, extraArgs: string[]) {
  for (const [names, loader] of LOADER) {
    if (names.includes(cmd)) {
      const mod = await loader();
      const register = Object.values(mod)[0] as RegisterFn;
      const program = new Command();
      program.name('afk').version('0.1.0');
      register(program);
      program.parse(['afk', cmd, ...extraArgs]);
      return;
    }
  }
  // Unknown command → full CLI
  const { runFullCLI } = await import('./full-cli.js');
  runFullCLI();
}
