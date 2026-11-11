#!/usr/bin/env node
/**
 * Thin process entry point. Command registration and dispatch live in
 * command-registry.ts so there is only one command-routing path.
 */
import { readFileSync } from 'node:fs';

const packageMetadata = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const cmd = process.argv[2];
const extraArgs = process.argv.slice(3);

async function main(): Promise<void> {
  if (cmd === '--version' || cmd === '-V') {
    console.log(packageMetadata.version);
    return;
  }

  // Preserve stdin TTY for Ink by bypassing Commander when launching the board.
  if (process.argv.length <= 2) {
    const { startDashboard } = await import('./commands/board-entry.js');
    await startDashboard();
    return;
  }

  if (cmd === 'board') {
    console.error('Error: use "afk" with no arguments to launch the TUI board.');
    process.exitCode = 1;
    return;
  }

  const { createCliPluginRuntime } = await import('./composition-root.js');
  const { dispatchCommand } = await import('./command-registry.js');
  let runtimePromise: ReturnType<typeof createCliPluginRuntime> | undefined;
  const composition = {
    argv: process.argv,
    createRuntime: () => runtimePromise ??= createCliPluginRuntime(),
  };
  try {
    const pluginRuntime = ['run', 'execute', 'reconcile', 'qa', 'loop', 'schedule', 'graph'].includes(cmd)
      && !extraArgs.some(argument => argument === '--help' || argument === '-h')
      ? await composition.createRuntime() : undefined;
    await dispatchCommand(cmd, extraArgs, { ...composition, pluginRuntime });
  } finally {
    const pluginRuntime = await runtimePromise?.catch(() => undefined);
    try { await pluginRuntime?.dispose(); }
    catch { throw new Error('Plugin runtime cleanup failed'); }
  }
}

main().catch((error: unknown) => {
  const code = (error as { code?: string }).code;
  if (code === 'commander.help' || code === 'commander.helpDisplayed') return;

  if (
    typeof code === 'string'
    && code.startsWith('commander.')
    && process.argv.includes('backlog')
    && process.argv.includes('--json')
  ) {
    process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
    return;
  }

  // Commander has already printed invalid argument diagnostics.
  if (code === 'commander.invalidArgument') {
    process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
    return;
  }

  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
