import { Command } from 'commander';
import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { buildCompletionTree } from '../lib/completion/tree';
import { extractSpec } from '../lib/completion/spec';
import { emitZsh, emitBash, emitFish } from '../lib/completion/shells';

const SHELLS = ['zsh', 'bash', 'fish'] as const;
type Shell = (typeof SHELLS)[number];

const BEGIN = '# >>> afk completion >>>';
const END = '# <<< afk completion <<<';

function isShell(s: string): s is Shell {
  return (SHELLS as readonly string[]).includes(s);
}

function detectShell(): Shell | undefined {
  const base = (process.env.SHELL || '').split('/').pop() || '';
  return isShell(base) ? base : undefined;
}

function rcPath(shell: Shell): string {
  const home = process.env.HOME || homedir();
  switch (shell) {
    case 'zsh': return join(home, '.zshrc');
    case 'bash': return join(home, '.bashrc');
    case 'fish': return join(home, '.config', 'fish', 'config.fish');
  }
}

function sourceLine(shell: Shell): string {
  return shell === 'fish' ? 'afk completion fish | source' : `eval "$(afk completion ${shell})"`;
}

/** Append an idempotent completion block to the shell rc file. */
function installCompletion(shell?: string): { rc: string; installed: boolean } {
  let resolved: Shell;
  if (shell) {
    if (!isShell(shell)) throw new Error(`Unsupported shell '${shell}'. Supported: ${SHELLS.join(', ')}.`);
    resolved = shell;
  } else {
    const detected = detectShell();
    if (!detected) throw new Error('Could not detect shell from $SHELL. Specify: zsh, bash, or fish.');
    resolved = detected;
  }
  const rc = rcPath(resolved);
  const existing = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
  if (existing.includes(BEGIN)) return { rc, installed: false };
  mkdirSync(dirname(rc), { recursive: true });
  appendFileSync(rc, `\n${BEGIN}\n${sourceLine(resolved)}\n${END}\n`);
  return { rc, installed: true };
}

function printScript(shell: string): void {
  const spec = extractSpec(buildCompletionTree());
  switch (shell) {
    case 'zsh': process.stdout.write(emitZsh(spec)); return;
    case 'bash': process.stdout.write(emitBash(spec)); return;
    case 'fish': process.stdout.write(emitFish(spec)); return;
    default:
      throw new Error(`Unsupported shell '${shell}'. Supported: ${SHELLS.join(', ')}.`);
  }
}

/**
 * Register the `completion` and hidden `__complete` commands.
 *
 * `afk completion <shell>` prints an eval-able completion script with inlined
 * static data. `afk completion <shell> --install` (or `--install` alone to
 * auto-detect from $SHELL) appends an idempotent block to the shell rc file.
 * `afk __complete` is the reserved dynamic-completion callback the scripts
 * invoke for argument-value positions; it returns no candidates until dynamic
 * completion is implemented.
 */
export function registerCompletionCommands(program: Command): void {
  program
    .command('completion [shell]')
    .description('Print a shell completion script, or install it with --install.')
    .option('--install', 'Write an idempotent block to the shell rc file instead of printing.')
    .action(function (this: Command, shell: string | undefined, options: { install?: boolean }) {
      if (options.install) {
        try {
          const { rc, installed } = installCompletion(shell);
          console.log(installed ? `Installed afk completion into ${rc}` : `afk completion already installed in ${rc}`);
          if (installed) console.log(`Restart your shell or run: source ${rc}`);
        } catch (e) {
          this.error((e as Error).message, { exitCode: 1 });
        }
        return;
      }
      if (!shell) {
        this.error('Specify a shell (zsh, bash, fish) or use --install.', { exitCode: 1 });
      }
      try {
        printScript(shell);
      } catch (e) {
        this.error((e as Error).message, { exitCode: 1 });
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
