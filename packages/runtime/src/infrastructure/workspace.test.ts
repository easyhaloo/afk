import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { executionWorkspacePath, resolveWorkspaceRoot, workspaceDataDirectory, workspaceStateDirectory } from './workspace.js';

describe('AFK workspace resolution', () => {
  it('keeps execution under the loop workspace regardless of AFK_WORKSPACE', () => {
    expect(resolveWorkspaceRoot({ AFK_WORKSPACE: '/workspace/repos' })).toBe(join(homedir(), '.loop-workspace'));
  });

  it('keeps system state in AFK home regardless of AFK_WORKSPACE', () => {
    expect(workspaceStateDirectory({ AFK_WORKSPACE: '/workspace/repos' }))
      .toBe(join(homedir(), '.afk'));
  });

  it('falls back to the AFK home directory', () => {
    expect(resolveWorkspaceRoot({})).toBe(join(homedir(), '.loop-workspace'));
    expect(workspaceStateDirectory({})).toBe(join(homedir(), '.afk'));
  });

  it('ignores a blank workspace setting', () => {
    expect(workspaceStateDirectory({ AFK_WORKSPACE: '   ' })).toBe(join(homedir(), '.afk'));
  });

  it('uses the same isolated execution path for a canonical work item', () => {
    expect(executionWorkspacePath('github:acme/api#42')).toBe(join(homedir(), '.loop-workspace', 'github/acme/api/42'));
    expect(executionWorkspacePath('WI-2026-018')).toBe(join(homedir(), '.loop-workspace', 'WI-2026-018'));
  });

  it.each(['../escape', 'github:../api#42', 'github:acme/api#0', ' task', 'a\\b'])('rejects unsafe work item paths: %s', value => {
    expect(() => executionWorkspacePath(value)).toThrow();
  });

  it('isolates workspace data under AFK home without writing into the repository', () => {
    const first = workspaceDataDirectory('/workspace/api');
    expect(first.startsWith(join(homedir(), '.afk', 'workspaces') + '/')).toBe(true);
    expect(first).toBe(workspaceDataDirectory(resolve('/workspace/api')));
    expect(first).not.toBe(workspaceDataDirectory('/workspace/web'));
  });
});
