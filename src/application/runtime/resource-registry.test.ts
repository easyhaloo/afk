import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AfkResourceRegistry, workspaceRootForWorktree } from './resource-registry';

async function registryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'afk-resources-'));
  return new AfkResourceRegistry({ databasePath: join(root, 'resources.sqlite') });
}

describe('AfkResourceRegistry', () => {
  it('keeps resources isolated by AFK workspace and records only explicit identities', async () => {
    const registry = await registryFixture();
    registry.register({
      workspacePath: '/repo-a',
      worktreePath: '/repo-a/.worktrees/issue-42',
      runId: 'run-a',
      kind: 'tmux',
      origin: 'local-sandbox',
      name: 'afk-42',
      detail: 'interactive session',
    });
    registry.register({
      workspacePath: '/repo-b',
      worktreePath: '/repo-b/.worktrees/issue-7',
      runId: 'run-b',
      kind: 'container',
      origin: 'container-sandbox',
      engine: 'docker',
      name: 'afk-12345678',
      externalId: 'container-id',
    });

    expect(registry.listActive('/repo-a')).toEqual([
      expect.objectContaining({ name: 'afk-42', runId: 'run-a', kind: 'tmux', status: 'active' }),
    ]);
    expect(registry.listActive('/repo-b')).toEqual([
      expect.objectContaining({ name: 'afk-12345678', engine: 'docker', externalId: 'container-id' }),
    ]);
  });

  it('upserts the same external resource and closes only the recorded worktree resources', async () => {
    const registry = await registryFixture();
    const resource = {
      workspacePath: '/repo',
      worktreePath: '/repo/.worktrees/issue-42',
      runId: 'run-42',
      kind: 'container' as const,
      origin: 'container-sandbox' as const,
      engine: 'podman' as const,
      name: 'afk-42-container',
      externalId: 'first-id',
    };
    registry.register(resource);
    registry.register({ ...resource, externalId: 'replacement-id', detail: 'recreated' });

    expect(registry.listActive('/repo')).toEqual([
      expect.objectContaining({ externalId: 'replacement-id', detail: 'recreated' }),
    ]);

    registry.closeActiveForWorktree('/repo', '/repo/.worktrees/issue-42', 'container-sandbox');
    expect(registry.listActive('/repo')).toEqual([]);
    expect(registry.listByRun('run-42')).toEqual([
      expect.objectContaining({ status: 'closed' }),
    ]);
  });

  it('derives the selected AFK workspace from its standard worktree directory', () => {
    expect(workspaceRootForWorktree('/Users/demo/project/.worktrees/issue-42')).toBe('/Users/demo/project');
    expect(workspaceRootForWorktree('/Users/demo/project')).toBe('/Users/demo/project');
  });
});
