import { Command } from 'commander';
import { buildCompletionTree } from '../lib/completion/tree';
import { extractSpec } from '../lib/completion/spec';
import { emitZsh, emitBash, emitFish } from '../lib/completion/shells';

const SUPPORTED = ['zsh', 'bash', 'fish'] as const;

/**
 * Register the `completion` and hidden `__complete` commands.
 *
 * `afk completion <shell>` prints an eval-able completion script with inlined
 * static data (commands/subcommands/options). `afk __complete` is the reserved
 * dynamic-completion callback the scripts invoke for argument-value positions;
 * it returns no candidates until dynamic completion is implemented.
 */
export function registerCompletionCommands(program: Command): void {
  program
    .command('completion <shell>')
    .description('Print a shell completion script. Usage: eval "$(afk completion zsh)"')
    .action(function (this: Command, shell: string) {
      const spec = extractSpec(buildCompletionTree());
      switch (shell) {
        case 'zsh':
          process.stdout.write(emitZsh(spec));
          return;
        case 'bash':
          process.stdout.write(emitBash(spec));
          return;
        case 'fish':
          process.stdout.write(emitFish(spec));
          return;
        default:
          this.error(`Unsupported shell '${shell}'. Supported: ${SUPPORTED.join(', ')}.`, { exitCode: 1 });
      }
    });

  program
    .command('__complete [words...]', { hidden: true })
    .description('Internal: dynamic completion callback (reserved, currently empty).')
    .action(() => {
      // Reserved for dynamic value completion (issue IDs, branch names, etc.).
      // Shell scripts already route argument-value positions here; until
      // implemented, it returns no candidates.
    });
}
