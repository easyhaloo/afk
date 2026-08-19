#!/usr/bin/env node
/**
 * Process entrypoint. Command routing lives entirely under src/cli.
 */
const command = process.argv[2];
const extraArgs = process.argv.slice(3);

async function main(): Promise<void> {
  if (command === '--version' || command === '-V') {
    console.log('0.1.0');
    return;
  }

  if (process.argv.length <= 2) {
    const { startDashboard } = await import('./cli/commands/board-entry.js');
    await startDashboard();
    return;
  }

  if (command === 'board') {
    console.error('Error: use "afk" with no arguments to launch the TUI board.');
    process.exit(1);
    return;
  }

  const { lazyLoad } = await import('./cli/lazy-loader.js');
  await lazyLoad(command, extraArgs);
}

main().catch(error => {
  const code = (error as { code?: string }).code;
  if (code === 'commander.help' || code === 'commander.helpDisplayed') return;
  if (code === 'commander.invalidArgument') {
    process.exitCode = (error as { exitCode?: number }).exitCode ?? 1;
    return;
  }
  console.error(error);
  process.exit(1);
});
