#!/usr/bin/env node
/**
 * Thin CLI dispatcher — lazy-loads only the command that is invoked.
 */
import { spawn } from 'child_process';
import { resolve } from 'path';

const cmd = process.argv[2];
const extraArgs = process.argv.slice(3);

async function main() {
  if (cmd === '--version' || cmd === '-V') {
    console.log('0.1.0');
    return;
  }

  if (cmd === 'dashboard' || cmd === 'ui') {
    // Fast path: spawn node with tsx loader to run dashboard entry directly
    const script = resolve(import.meta.dirname, 'commands', 'dashboard-entry.js');
    const tsxUrl = `file://${resolve(import.meta.dirname, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs')}`;
    spawn(process.execPath, ['--import', tsxUrl, script, ...extraArgs], {
      stdio: 'inherit',
      detached: false,
    });
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
