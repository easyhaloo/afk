import { describe, expect, it, vi } from 'vitest';
import {
  confirmBacklogMerge,
  createBacklog,
  interruptBacklog,
  retryBacklog,
} from './commands';
import type { BacklogItem, QABacklogProvider } from './index';
import { parseReworkRecord, renderReworkRecord, type ReworkRecord } from './rework-record';

describe('backlog commands', () => {
  it('creates a backlog item and returns its canonical URL', async () => {
    const provider: BacklogManagementProvider = {
      get: vi.fn(), list: vi.fn(), addTag: vi.fn(), removeTag: vi.fn(), initialize: vi.fn(),
      create: vi.fn().mockResolvedValue({
        id: '42', title: 'Add login', description: 'body', parentId: '7', dependsOn: ['6'],
        state: 'ready', executionMode: 'afk', tags: ['feature'],
        branchName: 'afk/backlog-42', providerRef: 'gitlab:repo#42', webUrl: 'https://gitlab.example/issues/42',
      }),
    };

    await expect(createBacklog(provider, {
      title: 'Add login', description: 'body', parentId: '7', dependsOn: ['6'], executionMode: 'afk', tags: ['feature'],
    })).resolves.toMatchObject({ id: '42', webUrl: 'https://gitlab.example/issues/42' });
    expect(provider.create).toHaveBeenCalledWith(expect.objectContaining({ parentId: '7', dependsOn: ['6'] }));
  });

  it('accepts operator-authored rework records', () => {
    const record: ReworkRecord = {
      version: 1,
      id: 'r1',
      attempt: 1,
      status: 'open',
      source: 'operator',
      summary: 'Retry after manual review',
      failedCriteria: [],
      requiredChecks: [],
      createdAt: '2026-09-17T00:00:00.000Z',
    };

    expect(parseReworkRecord({ id: 'comment-1', body: renderReworkRecord(record) })?.record).toEqual(record);
  });

  it.each(['in_progress', 'verification'] as const)('interrupts a %s backlog into blocked hitl', async state => {
    const item = backlogItem({ state, executionMode: 'afk' });
    const provider = lifecycleProvider(item);

    await expect(interruptBacklog(provider, item.id, ' operator requested stop ')).resolves.toMatchObject({
      state: 'blocked',
      executionMode: 'hitl',
    });
    expect(provider.transition).toHaveBeenCalledWith(item.id, 'blocked', { reason: 'operator requested stop' });
    expect(provider.setExecutionMode).toHaveBeenCalledWith(item.id, 'hitl');
  });

  it('rejects interruption outside active execution states', async () => {
    const provider = lifecycleProvider(backlogItem({ state: 'ready' }));

    await expect(interruptBacklog(provider, '42', 'stop')).rejects.toThrow('cannot interrupt backlog 42 from ready');
    expect(provider.transition).not.toHaveBeenCalled();
    expect(provider.setExecutionMode).not.toHaveBeenCalled();
  });

  it('retries only blocked hitl work with an operator rework record', async () => {
    const item = backlogItem({ state: 'blocked', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);

    await expect(retryBacklog(provider, item.id, ' retry after inspection ')).resolves.toMatchObject({
      state: 'rework',
      executionMode: 'afk',
    });
    expect(provider.createRework).toHaveBeenCalledWith(item.id, {
      source: 'operator',
      summary: 'retry after inspection',
      failedCriteria: [],
      requiredChecks: [],
    });
  });

  it('rejects retry unless both blocked and hitl', async () => {
    const provider = lifecycleProvider(backlogItem({ state: 'blocked', executionMode: 'afk' }));

    await expect(retryBacklog(provider, '42', 'retry')).rejects.toThrow('requires blocked + hitl');
    expect(provider.createRework).not.toHaveBeenCalled();
  });

  it('merges the associated root change, confirms merged, then marks the backlog done', async () => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'open', sourceBranch: item.branchName, targetBranch: 'main' }),
      merge: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'merged', sourceBranch: item.branchName, targetBranch: 'main' }),
    };

    await expect(confirmBacklogMerge(provider, changes, item.id, 'main')).resolves.toMatchObject({ state: 'done' });
    expect(changes.merge).toHaveBeenCalledWith('mr-9');
    expect(changes.get).toHaveBeenCalledWith('mr-9');
    expect(provider.transition).toHaveBeenCalledWith(item.id, 'done', { changeId: 'mr-9' });
    expect(changes.get.mock.invocationCallOrder[0]).toBeLessThan(provider.transition.mock.invocationCallOrder[0]);
  });

  it('resumes merge confirmation when the associated change is already merged', async () => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'merged', sourceBranch: item.branchName, targetBranch: 'main' }),
      merge: vi.fn(),
      get: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'merged', sourceBranch: item.branchName, targetBranch: 'main' }),
    };

    await expect(confirmBacklogMerge(provider, changes, item.id, 'main')).resolves.toMatchObject({ state: 'done' });
    expect(changes.merge).not.toHaveBeenCalled();
    expect(provider.transition).toHaveBeenCalledWith(item.id, 'done', { changeId: 'mr-9' });
  });

  it('accepts the QA verification branch created for a root backlog', async () => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const verificationBranch = `${item.branchName}-qa`;
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'open', sourceBranch: verificationBranch, targetBranch: 'main' }),
      merge: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'merged', sourceBranch: verificationBranch, targetBranch: 'main' }),
    };

    await expect(confirmBacklogMerge(provider, changes, item.id, 'main')).resolves.toMatchObject({ state: 'done' });
    expect(changes.merge).toHaveBeenCalledWith('mr-9');
    expect(provider.transition).toHaveBeenCalledWith(item.id, 'done', { changeId: 'mr-9' });
  });

  it('refuses to finish when the change is not confirmed merged', async () => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'open', sourceBranch: item.branchName, targetBranch: 'main' }),
      merge: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'open', sourceBranch: item.branchName, targetBranch: 'main' }),
    };

    await expect(confirmBacklogMerge(provider, changes, item.id, 'main')).rejects.toThrow('must be merged');
    expect(provider.transition).not.toHaveBeenCalled();
  });

  it.each([
    [{ id: 'mr-9', state: 'open', sourceBranch: 'other', targetBranch: 'main' }, 'must use source branch'],
    [{ id: 'mr-9', state: 'open', sourceBranch: 'afk/backlog-42', targetBranch: 'develop' }, 'must target main'],
    [{ id: 'mr-9', state: 'open', sourceBranch: 'afk/backlog-42', targetBranch: 'main', mergeable: false }, 'must be mergeable'],
  ] as const)('rejects unsafe merge candidate %s', async (change, message) => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = { findForBacklog: vi.fn().mockResolvedValue(change), merge: vi.fn(), get: vi.fn() };

    await expect(confirmBacklogMerge(provider, changes, item.id, 'main')).rejects.toThrow(message);
    expect(changes.merge).not.toHaveBeenCalled();
  });

  it.each([
    [{ parentId: '7', state: 'merge_ready', executionMode: 'hitl' }, 'must be a root backlog'],
    [{ state: 'verification', executionMode: 'hitl' }, 'requires merge_ready + hitl'],
    [{ state: 'merge_ready', executionMode: 'afk' }, 'requires merge_ready + hitl'],
  ] as const)('rejects merge confirmation when %s', async (overrides, message) => {
    const item = backlogItem(overrides);
    const provider = lifecycleProvider(item);
    const changes = { findForBacklog: vi.fn(), merge: vi.fn(), get: vi.fn() };

    await expect(confirmBacklogMerge(provider, changes, item.id, 'main')).rejects.toThrow(message);
    expect(changes.findForBacklog).not.toHaveBeenCalled();
  });

  it('treats already reached lifecycle targets as idempotent success', async () => {
    await expect(interruptBacklog(lifecycleProvider(backlogItem({ state: 'blocked', executionMode: 'hitl' })), '42', 'stop')).resolves.toMatchObject({ state: 'blocked' });
    await expect(retryBacklog(lifecycleProvider(backlogItem({ state: 'rework', executionMode: 'afk' })), '42', 'retry')).resolves.toMatchObject({ state: 'rework' });
    await expect(confirmBacklogMerge(lifecycleProvider(backlogItem({ state: 'done', executionMode: 'hitl' })), { findForBacklog: vi.fn(), merge: vi.fn(), get: vi.fn() }, '42', 'main')).resolves.toMatchObject({ state: 'done' });
  });
});

function backlogItem(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: '42',
    title: 'Task',
    description: 'Body',
    dependsOn: [],
    state: 'ready',
    executionMode: 'afk',
    tags: [],
    branchName: 'afk/backlog-42',
    providerRef: 'stub:42',
    ...overrides,
  };
}

function lifecycleProvider(item: BacklogItem): QABacklogProvider & {
  transition: ReturnType<typeof vi.fn>;
  setExecutionMode: ReturnType<typeof vi.fn>;
  createRework: ReturnType<typeof vi.fn>;
} {
  const current = { ...item };
  return {
    get: vi.fn(async () => ({ ...current })),
    list: vi.fn(),
    create: vi.fn(),
    addTag: vi.fn(),
    removeTag: vi.fn(),
    initialize: vi.fn(),
    transition: vi.fn(async (_id: string, state: BacklogItem['state']) => {
      current.state = state;
      if (state === 'blocked') current.executionMode = 'hitl';
    }),
    setExecutionMode: vi.fn(async (_id: string, mode: BacklogItem['executionMode']) => {
      current.executionMode = mode;
    }),
    createRework: vi.fn(async (_id: string, input) => {
      current.state = 'rework';
      current.executionMode = 'afk';
      return {
        ...input,
        version: 1 as const,
        id: 'r1',
        attempt: 1,
        status: 'open' as const,
        createdAt: '2026-09-17T00:00:00.000Z',
      };
    }),
    getActiveRework: vi.fn(),
    resolveRework: vi.fn(),
  };
}
