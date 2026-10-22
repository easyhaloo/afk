import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveWorkspaceRoot, workspaceStateDirectory } from './workspace.js';

describe('AFK workspace resolution', () => {
  it('uses AFK_WORKSPACE as the workspace root', () => {
    expect(resolveWorkspaceRoot({ AFK_WORKSPACE: '/workspace/repos' })).toBe(resolve('/workspace/repos'));
  });

  it('keeps workspace-local state in the workspace .afk directory', () => {
    expect(workspaceStateDirectory({ AFK_WORKSPACE: '/workspace/repos' }))
      .toBe(join(resolve('/workspace/repos'), '.afk'));
  });

  it('falls back to the AFK home directory', () => {
    expect(resolveWorkspaceRoot({})).toBe(join(homedir(), '.afk'));
    expect(workspaceStateDirectory({})).toBe(join(homedir(), '.afk'));
  });

  it('ignores a blank workspace setting', () => {
    expect(workspaceStateDirectory({ AFK_WORKSPACE: '   ' })).toBe(join(homedir(), '.afk'));
  });
});
