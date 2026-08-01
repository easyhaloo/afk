import { describe, it, expect, vi } from 'vitest';
import { Command } from 'commander';
import { registerCompletionCommands } from './completion';

function run(args: string[]): { stdout: string; exitCode: number | undefined } {
  const program = new Command();
  program.exitOverride();
  registerCompletionCommands(program);
  let stdout = '';
  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += chunk;
    return true;
  });
  let exitCode: number | undefined;
  try {
    program.parse(['node', 'afk', ...args]);
  } catch (e) {
    exitCode = (e as { exitCode?: number }).exitCode;
  }
  writeSpy.mockRestore();
  return { stdout, exitCode };
}

describe('registerCompletionCommands', () => {
  it('completion zsh prints a #compdef afk script', () => {
    const { stdout } = run(['completion', 'zsh']);
    expect(stdout).toContain('#compdef afk');
  });

  it('completion bash prints a complete -F binding', () => {
    const { stdout } = run(['completion', 'bash']);
    expect(stdout).toContain('complete -F _afk afk');
  });

  it('completion fish prints complete -c afk declarations', () => {
    const { stdout } = run(['completion', 'fish']);
    expect(stdout).toContain('complete -c afk');
  });

  it('completion <invalid shell> exits non-zero', () => {
    const { exitCode } = run(['completion', 'powershell']);
    expect(exitCode).toBe(1);
  });

  it('__complete returns no candidates (pre-wired, currently empty)', () => {
    const { stdout } = run(['__complete', 'issue', 'get']);
    expect(stdout).toBe('');
  });
});
