import { workspaceStateDirectory } from './infrastructure/workspace.js';
import { describe, expect, it, vi } from 'vitest';
import { createBacklogRuntime } from './backlog.js';
import type { QABacklogProvider } from './domain/backlog/index.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('backlog runtime', () => {
  it('scopes provider construction to each workspace and platform without changing cwd', async () => {
    const list = vi.fn(async () => []);
    const factory = vi.fn(async () => ({ backlog: { list } as unknown as QABacklogProvider, changes: {} as never }));
    const runtime = createBacklogRuntime(factory);
    const cwd = process.cwd();
    await runtime.list('/workspace/one', { platform: 'gitlab', state: 'ready' });
    await runtime.list('/workspace/two', { platform: 'github' });
    expect(factory.mock.calls).toEqual([[undefined, '/workspace/one', 'gitlab'], [undefined, '/workspace/two', 'github']]);
    expect(list).toHaveBeenCalledWith({ platform: 'gitlab', state: 'ready' });
    expect(process.cwd()).toBe(cwd);
  });

  it('returns the provider state after a tag update', async () => {
    const get = vi.fn(async () => ({ id: '42', tags: ['urgent'] }));
    const addTag = vi.fn(async () => undefined);
    const factory = async () => ({ backlog: { get, addTag } as unknown as QABacklogProvider, changes: {} as never });
    await expect(createBacklogRuntime(factory).addTag('/workspace', '42', 'urgent')).resolves.toEqual({ id: '42', tags: ['urgent'] });
    expect(addTag).toHaveBeenCalledWith('42', 'urgent');
    expect(get).toHaveBeenCalledWith('42');
  });

  it('interrupts through the shared lifecycle transition rather than an application command', async () => {
    const item = { id: '42', state: 'in_progress', executionMode: 'afk' };
    const transition = vi.fn(async () => { item.state = 'blocked'; });
    const setExecutionMode = vi.fn(async () => { item.executionMode = 'hitl'; });
    const runtime = createBacklogRuntime(async () => ({
      backlog: { get: async () => item, transition, setExecutionMode } as unknown as QABacklogProvider,
      changes: {} as never,
    }));
    expect(await runtime.interrupt('/workspace', '42', 'operator stopped')).toMatchObject({ state: 'blocked', executionMode: 'hitl' });
    expect(transition).toHaveBeenCalledWith('42', 'blocked', { reason: 'operator stopped' });
    expect(setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
  });

  it('checks the selected workspace target branch before confirming a merge', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'afk-backlog-merge-'));
    try {
      await mkdir(workspaceStateDirectory(), { recursive: true });
      await writeFile(join(workspaceStateDirectory(), 'config.yml'), 'targetBranch: release\n');
      const item = { id: '42', state: 'merge_ready', executionMode: 'hitl', branchName: 'afk/42' };
      const change = { id: 'pr-42', state: 'open', sourceBranch: 'afk/42-qa', targetBranch: 'release' };
      const merge = vi.fn(async () => { change.state = 'merged'; });
      const transition = vi.fn(async () => { item.state = 'done'; });
      const runtime = createBacklogRuntime(async () => ({
        backlog: { get: async () => item, transition } as unknown as QABacklogProvider,
        changes: { findForBacklog: async () => change, merge, get: async () => change } as never,
      }));
      expect(await runtime.confirmMerge(workspace, '42')).toMatchObject({ state: 'done' });
      expect(merge).toHaveBeenCalledWith('pr-42');
      expect(transition).toHaveBeenCalledWith('42', 'done', { changeId: 'pr-42' });
    } finally { await rm(workspace, { recursive: true, force: true }); }
  });
});
