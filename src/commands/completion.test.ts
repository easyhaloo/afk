import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
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

describe('completion --install', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-comp-'));
    vi.stubEnv('HOME', tmpHome);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes an idempotent block to ~/.zshrc', () => {
    const r1 = run(['completion', 'zsh', '--install']);
    expect(r1.exitCode).toBeUndefined();
    const zshrc = path.join(tmpHome, '.zshrc');
    const content = fs.readFileSync(zshrc, 'utf8');
    expect(content).toContain('>>> afk completion >>>');
    expect(content).toContain('eval "$(afk completion zsh)"');

    // second run must not duplicate the block
    run(['completion', 'zsh', '--install']);
    const count = (fs.readFileSync(zshrc, 'utf8').match(/>>> afk completion >>>/g) || []).length;
    expect(count).toBe(1);
  });

  it('auto-detects shell from $SHELL when --install is given without a shell', () => {
    vi.stubEnv('SHELL', '/bin/bash');
    run(['completion', '--install']);
    expect(fs.readFileSync(path.join(tmpHome, '.bashrc'), 'utf8')).toContain('eval "$(afk completion bash)"');
  });

  it('errors on unsupported shell with --install', () => {
    const { exitCode } = run(['completion', 'powershell', '--install']);
    expect(exitCode).toBe(1);
  });
});
