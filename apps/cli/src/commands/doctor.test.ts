import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectWorkspaceDisk } from '@afk/runtime/execution';
import { registerDoctorCommands } from './doctor.js';

vi.mock('@afk/runtime/execution', () => ({ inspectWorkspaceDisk: vi.fn() }));
vi.mock('../output.js', () => ({ detail: vi.fn(), warning: vi.fn(), handleCommandError: vi.fn() }));

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); process.exitCode = 0; });

function program() {
  const command = new Command().exitOverride();
  registerDoctorCommands(command);
  return command;
}

function report() {
  return { root: '/cache', repositories: [], dependencies: [], workspaces: [], diagnostics: [],
    totals: { repositoryBytes: 0, dependencyBytes: 0, workspaceBytes: 0, reclaimableBytes: 0 } };
}

describe('doctor commands', () => {
  it('defaults to read-only inspection', async () => {
    vi.mocked(inspectWorkspaceDisk).mockResolvedValue(report());
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program().parseAsync(['node', 'afk', 'doctor', '--json']);
    expect(inspectWorkspaceDisk).toHaveBeenCalledWith({ root: undefined, cleanup: undefined });
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(report());
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('passes only the explicit cleanup target and root to runtime and reports the result as JSON', async () => {
    const result = { ...report(), cleanup: { target: 'github:acme/api#42', path: '/cache/github/acme/api/42', status: 'removed' as const, bytes: 128 } };
    vi.mocked(inspectWorkspaceDisk).mockResolvedValue(result);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await program().parseAsync(['node', 'afk', 'doctor', '--workspace-root', '/cache', '--cleanup', 'github:acme/api#42', '--json']);
    expect(inspectWorkspaceDisk).toHaveBeenCalledWith({ root: '/cache', cleanup: 'github:acme/api#42' });
    expect(JSON.parse(output.mock.calls[0][0])).toEqual(result);
  });

  it('reports retention diagnostics with a failing exit code', async () => {
    vi.mocked(inspectWorkspaceDisk).mockResolvedValue({ ...report(), diagnostics: ['active lease'],
      cleanup: { target: '/cache/workspace', status: 'retained', bytes: 0, reason: 'active lease' } });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await program().parseAsync(['node', 'afk', 'doctor', '--cleanup', '/cache/workspace', '--json']);
    expect(process.exitCode).toBe(1);
  });

  it('requires a cleanup target instead of allowing blanket deletion', async () => {
    const command = program();
    command.configureOutput({ writeErr: () => {} });
    await expect(command.parseAsync(['node', 'afk', 'doctor', '--cleanup'])).rejects.toThrow('argument missing');
    expect(inspectWorkspaceDisk).not.toHaveBeenCalled();
    expect(command.commands[0].helpInformation()).toContain('--cleanup <target>');
  });
});
