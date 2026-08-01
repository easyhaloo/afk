#!/usr/bin/env node
/**
 * Thin CLI dispatcher — lazy-loads only the command that is invoked.
 */
import { resolve } from 'path';

const cmd = process.argv[2];
const extraArgs = process.argv.slice(3);

// NOTE: this dispatcher intentionally uses raw console.log/console.error —
// importing cli-utils (chalk/pino) here would defeat lazy-loading by pulling
// the whole logging stack into every command's startup path. User-facing
// status lines live in commands via the cli-utils helpers; this file only
// handles the version contract and last-resort errors.
async function main() {
  if (cmd === '--version' || cmd === '-V') {
    console.log('0.1.0');
    return;
  }

  // No args: launch TUI directly (preserve stdin TTY for Ink)
  if (process.argv.length <= 2) {
    const { startDashboard } = await import('./commands/board-entry.js');
    await startDashboard();
    return;
  }

  // Explicit "board" command: not supported, use "afk" with no args
  if (cmd === 'board') {
    console.error('Error: use "afk" with no arguments to launch the TUI board.');
    process.exit(1);
    return;
  }

  // All other commands: lazy-load via dynamic import
  const { lazyLoad } = await import('./lazy-loader.js');
  await lazyLoad(cmd, extraArgs);
}

main().catch(err => {
  const code = (err as { code?: string }).code;
  if (code === 'commander.help' || code === 'commander.helpDisplayed') {
    return;
  }
  // Invalid option arguments: commander already printed the error message —
  // don't duplicate it with a stack trace. Preserve its exit code (1).
  if (code === 'commander.invalidArgument') {
    process.exitCode = (err as { exitCode?: number }).exitCode ?? 1;
    return;
  }
  console.error(err);
  process.exit(1);
});
