import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AFK_RESOURCE_ENGINES,
  AFK_RESOURCE_KINDS,
  AFK_RESOURCE_ORIGINS,
  AFK_RESOURCE_STATUSES,
} from '@afk/core';
import { AfkResourceRegistry, getAfkResourceRegistry, readActiveAfkResources, readRunAfkResources, sqlValueList, workspaceRootForWorktree } from './resource-registry.js';

async function registryFixture() {
  const root = await mkdtemp(join(tmpdir(), 'afk-resources-'));
  return new AfkResourceRegistry({ databasePath: join(root, 'resources.sqlite') });
}

describe('AfkResourceRegistry', () => {
  it('retains registered resource metadata when reading it from storage', async () => {
    const registry = await registryFixture();
    registry.register({
      workspacePath: '/repo',
      worktreePath: '/repo/.worktrees/issue-42',
      kind: 'tmux',
      origin: 'local-sandbox',
      name: 'afk-42',
      metadata: { branch: 'feature', generation: 2, custom: { enabled: true } },
    });

    expect(registry.listActive('/repo')[0]?.metadata).toEqual({
      branch: 'feature', generation: 2, custom: { enabled: true },
    });
  });
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

  it('reads what the registry wrote, by workspace and by run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-resources-'));
    const databasePath = join(root, 'resources.sqlite');
    const registry = new AfkResourceRegistry({ databasePath });
    registry.register({
      workspacePath: '/repo',
      worktreePath: '/repo/.worktrees/issue-42',
      runId: 'run-42',
      kind: 'tmux',
      origin: 'local-sandbox',
      name: 'afk-42',
      metadata: { branch: 'feature' },
    });

    expect(readActiveAfkResources(databasePath, ['/repo'])).toEqual([
      expect.objectContaining({ name: 'afk-42', runId: 'run-42', metadata: { branch: 'feature' } }),
    ]);
    expect(readRunAfkResources(databasePath, 'run-42')).toEqual([
      expect.objectContaining({ name: 'afk-42', status: 'active' }),
    ]);
  });

  it('reads without creating the database, and answers with nothing when there is none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-resources-'));
    const databasePath = join(root, 'resources.sqlite');

    expect(readActiveAfkResources(databasePath, ['/repo'])).toEqual([]);
    expect(readRunAfkResources(databasePath, 'run-42')).toEqual([]);
    expect(existsSync(databasePath)).toBe(false);
  });

  it('writes the table its check constraints from the same lists', () => {
    // The check constraint is the database's answer to "which values may
    // this column hold". A kind the registry can register and the
    // database refuses is a resource that cannot be stored at all.
    expect(sqlValueList(AFK_RESOURCE_KINDS)).toBe("'tmux', 'container', 'isolate-service'");
    expect(sqlValueList(AFK_RESOURCE_ORIGINS)).toBe("'local-sandbox', 'container-sandbox', 'isolate'");
    expect(sqlValueList(AFK_RESOURCE_ENGINES)).toBe("'docker', 'podman'");
    expect(sqlValueList(AFK_RESOURCE_STATUSES)).toBe("'active', 'closed', 'missing', 'failed'");
  });

  it('derives the selected AFK workspace from its standard worktree directory', () => {
    expect(workspaceRootForWorktree('/Users/demo/project/.worktrees/issue-42')).toBe('/Users/demo/project');
    expect(workspaceRootForWorktree('/Users/demo/project')).toBe('/Users/demo/project');
  });
});
