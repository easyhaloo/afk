/**
 * Lazy-loads command modules for all non-board commands.
 */
import { Command } from 'commander';
import { COMMANDS } from './command-registry.js';

export async function lazyLoad(cmd: string, extraArgs: string[]) {
  for (const entry of COMMANDS) {
    if (!entry.names.includes(cmd)) continue;

    try {
      const register = await entry.loader();
      const program = new Command();
      program.name('afk').version('0.1.0').exitOverride();
      register(program);

      // Parse on the command that owns the remaining args. Commander 12
      // routes multi-level subcommands poorly from a synthetic argv on the
      // top-level program, and its parse() always slices argv[0..1]
      // (node + script) off whatever it receives - so give it the synthetic
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
  // Unknown command -> full CLI
  const { runFullCLI } = await import('./full-cli.js');
  await runFullCLI();
}
