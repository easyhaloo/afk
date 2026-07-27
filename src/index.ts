#!/usr/bin/env node
/**
 * Thin CLI dispatcher — lazy-loads only the command that is invoked.
 */
import { Command } from 'commander';

const cmd = process.argv[2];
const extraArgs = process.argv.slice(3);

type RegisterFn = (p: Command) => void;

const COMMANDS: [string[], () => Promise<{ [k: string]: RegisterFn }>][] = [
  [['dashboard', 'ui'], () => import('./commands/dashboard.js')],
  [['signal'], () => import('./commands/signal.js')],
  [['gitlab'], () => import('./commands/gitlab.js')],
  [['tmux'], () => import('./commands/tmux.js')],
  [['worktree'], () => import('./commands/worktree.js')],
  [['workflow'], () => import('./commands/workflow.js')],
  [['scheduler'], () => import('./commands/scheduler.js')],
  [['db'], () => import('./commands/db.js')],
  [['debug'], () => import('./commands/debug.js')],
  [['escalate'], () => import('./commands/escalate.js')],
  [['fork'], () => import('./commands/fork.js')],
];

async function main() {
  if (cmd === '--version' || cmd === '-V') {
    console.log('0.1.0');
    return;
  }

  for (const [names, loader] of COMMANDS) {
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

  // Unknown command → load full CLI for help or error
  const { runFullCLI } = await import('./full-cli.js');
  runFullCLI();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
