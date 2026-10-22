import { describe, expect, it, vi } from 'vitest';
import { createRuntimeBacklogService } from '../../electron/services/runtime-backlog-service.js';
import type { BacklogRuntime } from '@afk/runtime/backlog';

const item = { id: '42', title: 'task', description: 'demo', dependsOn: [], state: 'ready', executionMode: 'afk', tags: [], branchName: 'afk/42', providerRef: 'github:acme/app#42' };

function fixture() {
  const runtime = { list: vi.fn(async () => [item]), show: vi.fn(async () => item), create: vi.fn(async () => item), addTag: vi.fn(async () => item), removeTag: vi.fn(async () => item) };
  return { runtime, service: createRuntimeBacklogService(workspace => workspace, runtime as unknown as BacklogRuntime) };
}

describe('runtime backlog service', () => {
  it('keeps caches scoped to workspace and filters', async () => {
    const { runtime, service } = fixture();
    await service.list('/one', { state: 'ready' });
    await service.list('/one', { state: 'ready' });
    await service.list('/two', { state: 'ready' });
    await service.list('/one', { state: 'blocked' });
    expect(runtime.list).toHaveBeenCalledTimes(3);
    expect(runtime.list).toHaveBeenCalledWith('/two', { state: 'ready' });
  });

  it('invalidates cached lists after mutations', async () => {
    const { runtime, service } = fixture();
    await service.list('/one');
    await service.addTag('/one', '42', 'urgent');
    await service.list('/one');
    expect(runtime.list).toHaveBeenCalledTimes(2);
    expect(runtime.addTag).toHaveBeenCalledWith('/one', '42', 'urgent');
  });

  it('does not restore stale data when a request completes after invalidation', async () => {
    const { runtime, service } = fixture();
    let resolve: (items: typeof item[]) => void = () => undefined;
    runtime.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
    const pending = service.list('/one');
    service.invalidateListCache();
    resolve([item]);
    await pending;
    await service.list('/one');
    expect(runtime.list).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed runtime results at the IPC boundary', async () => {
    const { runtime, service } = fixture();
    runtime.show.mockResolvedValueOnce({ ...item, state: 'invented' });
    await expect(service.show('/one', '42')).rejects.toThrow();
  });
});
