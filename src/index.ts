#!/usr/bin/env node
/**
 * Thin CLI dispatcher — lazy-loads only the command that is invoked.
 */
import { resolve } from 'path';

const cmd = process.argv[2] ?? 'dashboard';
const extraArgs = process.argv.slice(3);

async function main() {
  if (cmd === '--version' || cmd === '-V') {
    console.log('0.1.0');
    return;
  }

  if (cmd === 'dashboard' || cmd === 'ui') {
    // Direct import to preserve stdin TTY for Ink
    const { startDashboard } = await import('./commands/dashboard-entry.js');
    await startDashboard();
    return;
  }

  // All other commands: lazy-load via dynamic import
  const { lazyLoad } = await import('./lazy-loader.js');
  lazyLoad(cmd, extraArgs);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
