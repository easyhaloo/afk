import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { buildCompletionTree } from '../completion/tree';
import { extractSpec } from '../../shared/completion/spec';
import { emitZsh, emitBash, emitFish } from '../../shared/completion/shells';

const SHELLS = ['zsh', 'bash', 'fish'] as const;
type Shell = (typeof SHELLS)[number];

const BEGIN = '# >>> afk completion >>>';
const END = '# <<< afk completion <<<';

function isShell(shell: string): shell is Shell {
  return (SHELLS as readonly string[]).includes(shell);
}

function detectShell(): Shell | undefined {
  const base = (process.env.SHELL || '').split('/').pop() || '';
  return isShell(base) ? base : undefined;
}

function emitScript(shell: Shell): string {
  const spec = extractSpec(buildCompletionTree());
  switch (shell) {
    case 'zsh': return emitZsh(spec);
    case 'bash': return emitBash(spec);
    case 'fish': return emitFish(spec);
  }
}

function completionFilePath(shell: Shell): string {
  const home = process.env.HOME || homedir();
  switch (shell) {
    case 'fish': return join(home, '.config', 'fish', 'completions', 'afk.fish');
    case 'zsh': return join(home, '.afk', 'completion', 'afk.zsh');
    case 'bash': return join(home, '.afk', 'completion', 'afk.bash');
  }
}

function rcFile(shell: Shell): string | undefined {
  const home = process.env.HOME || homedir();
  switch (shell) {
    case 'zsh': return join(home, '.zshrc');
    case 'bash': return join(home, '.bashrc');
    case 'fish': return undefined;
  }
}

interface InstallResult {
  file: string;
  rc: string | undefined;
  fileCreated: boolean;
  rcUpdated: boolean;
}

function installCompletion(shell?: string): InstallResult {
  let resolved: Shell;
  if (shell) {
    if (!isShell(shell)) throw new Error(`Unsupported shell '${shell}'. Supported: ${SHELLS.join(', ')}.`);
    resolved = shell;
  } else {
    const detected = detectShell();
    if (!detected) throw new Error('Could not detect shell from $SHELL. Specify: zsh, bash, or fish.');
    resolved = detected;
  }

  const file = completionFilePath(resolved);
  mkdirSync(dirname(file), { recursive: true });
  const fileCreated = !existsSync(file);
  writeFileSync(file, emitScript(resolved));

  const rc = rcFile(resolved);
  let rcUpdated = false;
  if (rc) {
    const existing = existsSync(rc) ? readFileSync(rc, 'utf8') : '';
    if (!existing.includes(BEGIN)) {
      appendFileSync(rc, `\n${BEGIN}\nsource \"${file}\"\n${END}\n`);
      rcUpdated = true;
    }
  }
  return { file, rc, fileCreated, rcUpdated };
}

function printScript(shell: string): void {
  const spec = extractSpec(buildCompletionTree());
  switch (shell) {
    case 'zsh': process.stdout.write(emitZsh(spec)); return;
    case 'bash': process.stdout.write(emitBash(spec)); return;
    case 'fish': process.stdout.write(emitFish(spec)); return;
    default: throw new Error(`Unsupported shell '${shell}'. Supported: ${SHELLS.join(', ')}.`);
  }
}

export function registerCompletionCommands(program: Command): void {
  program
    .command('completion [shell]')
    .description('Print a shell completion script, or install it with --install.')
    .option('--install', 'Write the completion script to a file and wire it into the shell rc.')
    .action(function (this: Command, shell: string | undefined, options: { install?: boolean }) {
      if (options.install) {
        try {
          const { file, rc, fileCreated, rcUpdated } = installCompletion(shell);
          console.log(`${fileCreated ? 'Wrote' : 'Refreshed'} completion script: ${file}`);
          if (rc) {
            console.log(rcUpdated ? `Added source line to ${rc}` : `${rc} already sources it`);
            console.log(`Restart your shell or run: source ${file}`);
          } else {
            console.log('fish auto-loads from ~/.config/fish/completions/ (no rc edit needed).');
          }
        } catch (error) {
          this.error((error as Error).message, { exitCode: 1 });
        }
        return;
      }
      if (!shell) {
        this.error('Specify a shell (zsh, bash, fish) or use --install.', { exitCode: 1 });
        return;
      }
      try { printScript(shell); }
      catch (error) { this.error((error as Error).message, { exitCode: 1 }); }
    });

  program
    .command('__complete [words...]', { hidden: true })
    .description('Internal: dynamic completion callback (reserved, currently empty).')
    .action(() => {});
}
