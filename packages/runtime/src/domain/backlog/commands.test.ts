import { describe, expect, it, vi } from 'vitest';
import {
  adoptBacklog,
  blockBacklog,
  confirmBacklogMerge,
  createBacklog,
  interruptBacklog,
  reconcileMergedBacklog,
  resolveExpectedTargetBranch,
  retryBacklog,
} from './commands.js';
import type { BacklogItem, BacklogManagementProvider, QABacklogProvider } from './index.js';
import { InMemoryBacklogProvider } from './index.js';
import { ManagementBacklogProvider } from './management-provider.js';
import { parseReworkRecord, renderReworkRecord, type ReworkRecord } from './rework-record.js';

describe('backlog commands', () => {
  it('rejects adoption when the provider has no optional adoption capability', async () => {
    const provider = new InMemoryBacklogProvider();
    await expect(adoptBacklog(provider, '42')).rejects.toThrow('does not support explicit issue adoption');
    await expect(adoptBacklog(new ManagementBacklogProvider(provider), '42')).rejects.toThrow('does not support explicit issue adoption');
  });

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

  it('closes the open rework record when a blocked execution ends', async () => {
    const provider = lifecycleProvider(backlogItem({ state: 'blocked', executionMode: 'hitl' }));
    provider.getActiveRework = vi.fn(async () => ({
      version: 1 as const,
      id: 'r1',
      attempt: 1,
      status: 'open' as const,
      source: 'operator' as const,
      summary: 'first attempt',
      failedCriteria: [],
      requiredChecks: [],
      createdAt: '2026-09-17T00:00:00.000Z',
    }));

    await blockBacklog(provider, '42', 'QA timed out');

    expect(provider.resolveRework).toHaveBeenCalledWith('42', 'r1', {
      summary: 'Rework r1 did not pass: QA timed out',
    });
    expect(provider.transition).toHaveBeenCalledWith('42', 'blocked', { reason: 'QA timed out' });
    expect(provider.setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
  });

  it('lets an operator retry an item whose rework attempt failed', async () => {
    const provider = new InMemoryBacklogProvider([
      backlogItem({ id: '42', state: 'blocked', executionMode: 'hitl' }),
    ]);
    await provider.createRework('42', {
      source: 'operator',
      summary: 'first attempt',
      failedCriteria: [],
      requiredChecks: [],
    });
    // The attempt answered the rework request and failed.
    await provider.transition('42', 'blocked', { reason: 'QA timed out' });
    await provider.setExecutionMode('42', 'hitl');
    await expect(provider.getActiveRework('42')).resolves.toMatchObject({ id: 'r1', status: 'open' });

    await expect(retryBacklog(provider, '42', 'second attempt')).resolves.toMatchObject({
      state: 'rework',
      executionMode: 'afk',
    });
    await expect(provider.getActiveRework('42')).resolves.toMatchObject({ id: 'r2', status: 'open' });
  });

  it('lets an operator retry an item whose failed attempt left its request open', async () => {
    const provider = new InMemoryBacklogProvider([
      backlogItem({ id: '42', state: 'blocked', executionMode: 'hitl' }),
    ]);
    await provider.createRework('42', {
      source: 'operator',
      summary: 'first attempt',
      failedCriteria: [],
      requiredChecks: [],
    });
    await provider.transition('42', 'blocked', { reason: 'QA timed out' });
    await provider.setExecutionMode('42', 'hitl');

    // The retry answers the previous request, so it closes that one first.
    await expect(retryBacklog(provider, '42', 'second attempt')).resolves.toMatchObject({
      state: 'rework',
      executionMode: 'afk',
    });
    await expect(provider.getActiveRework('42')).resolves.toMatchObject({ id: 'r2', status: 'open' });
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

  it('completes a root backlog whose change is already merged without merging anything', async () => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'merged', sourceBranch: `${item.branchName}-qa`, targetBranch: 'main' }),
      merge: vi.fn(),
      get: vi.fn(),
    };

    await expect(reconcileMergedBacklog(provider, changes, item.id, 'main')).resolves.toMatchObject({
      reconciled: true,
      item: { state: 'done' },
    });
    expect(changes.merge).not.toHaveBeenCalled();
    expect(provider.transition).toHaveBeenCalledWith(item.id, 'done', { changeId: 'mr-9' });
  });

  it('leaves the merge gate alone while the change is still open', async () => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'open', sourceBranch: `${item.branchName}-qa`, targetBranch: 'main' }),
      merge: vi.fn(),
      get: vi.fn(),
    };

    const outcome = await reconcileMergedBacklog(provider, changes, item.id, 'main');
    expect(outcome.reconciled).toBe(false);
    expect(outcome.reason).toMatch(/merge gate is still open/);
    expect(changes.merge).not.toHaveBeenCalled();
    expect(provider.transition).not.toHaveBeenCalled();
  });

  it('refuses to reconcile a change that targets another branch', async () => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'merged', sourceBranch: item.branchName, targetBranch: 'release' }),
      merge: vi.fn(),
      get: vi.fn(),
    };

    const outcome = await reconcileMergedBacklog(provider, changes, item.id, 'main');
    expect(outcome.reconciled).toBe(false);
    expect(outcome.reason).toMatch(/targets release/);
    expect(provider.transition).not.toHaveBeenCalled();
  });

  it('reconciles a child whose change was merged by a human', async () => {
    // A child waits for its human merge as "merge pending" when AFK merged
    // it, and as blocked when AFK could not. Both are the same situation,
    // and nothing else would ever bring the child in line with the branch
    // its work already landed on.
    const child = backlogItem({ id: '43', parentId: '42', state: 'blocked', executionMode: 'hitl' });
    const provider = lifecycleProvider(child);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-10', state: 'merged', sourceBranch: `${child.branchName}-qa`, targetBranch: 'release' }),
      merge: vi.fn(),
      get: vi.fn(),
    };

    const outcome = await reconcileMergedBacklog(provider, changes, child.id, 'release');
    expect(outcome.reconciled).toBe(true);
    expect(outcome.reason).toMatch(/mr-10 is merged/);
    expect(provider.transition).toHaveBeenCalledWith('43', 'done', { changeId: 'mr-10' });
  });

  it('leaves a blocked item alone while its change is still open', async () => {
    const child = backlogItem({ id: '43', parentId: '42', state: 'blocked', executionMode: 'hitl' });
    const provider = lifecycleProvider(child);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-10', state: 'open', sourceBranch: `${child.branchName}-qa`, targetBranch: 'release' }),
      merge: vi.fn(),
      get: vi.fn(),
    };

    const outcome = await reconcileMergedBacklog(provider, changes, child.id, 'release');
    expect(outcome.reconciled).toBe(false);
    expect(outcome.reason).toMatch(/merge gate is still open/);
    expect(provider.transition).not.toHaveBeenCalled();
  });

  it('resolves the branch a change has to have targeted from the item itself', async () => {
    const item = backlogItem({ state: 'merge_ready', executionMode: 'hitl', executionBase: '2025-11-8-show' });
    const provider = lifecycleProvider(item);

    // The body declares the ref the work starts from, and the execution
    // manifest is derived from it — so it is the branch the change lands on.
    expect(await resolveExpectedTargetBranch(provider, item, 'main')).toBe('2025-11-8-show');
    expect(await resolveExpectedTargetBranch(provider, backlogItem({ state: 'ready', executionMode: 'afk' }), 'main')).toBe('main');
  });

  it('reports an already completed backlog instead of reconciling it again', async () => {
    const item = backlogItem({ state: 'done', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = { findForBacklog: vi.fn(), merge: vi.fn(), get: vi.fn() };

    const outcome = await reconcileMergedBacklog(provider, changes, item.id, 'main');
    expect(outcome.reconciled).toBe(false);
    expect(outcome.reason).toMatch(/already done/);
    expect(provider.transition).not.toHaveBeenCalled();
  });

  it('repairs a stale merge-ready label on an issue the provider already closed', async () => {
    // The provider closed the issue when the change merged, so the derived
    // state reads done while the label still says "merge pending".
    const item = backlogItem({ state: 'done', labeledState: 'merge_ready', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = {
      findForBacklog: vi.fn().mockResolvedValue({ id: 'mr-9', state: 'merged', sourceBranch: `${item.branchName}-qa`, targetBranch: 'main' }),
      merge: vi.fn(),
      get: vi.fn(),
    };

    await expect(reconcileMergedBacklog(provider, changes, item.id, 'main')).resolves.toMatchObject({
      reconciled: true,
    });
    expect(provider.transition).toHaveBeenCalledWith(item.id, 'done', { changeId: 'mr-9' });
    expect(changes.merge).not.toHaveBeenCalled();
  });

  it('leaves a completed backlog whose label already says done alone', async () => {
    const item = backlogItem({ state: 'done', labeledState: 'done', executionMode: 'hitl' });
    const provider = lifecycleProvider(item);
    const changes = { findForBacklog: vi.fn(), merge: vi.fn(), get: vi.fn() };

    const outcome = await reconcileMergedBacklog(provider, changes, item.id, 'main');
    expect(outcome.reconciled).toBe(false);
    expect(outcome.reason).toMatch(/already done/);
    expect(provider.transition).not.toHaveBeenCalled();
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
  getActiveRework: ReturnType<typeof vi.fn>;
  resolveRework: ReturnType<typeof vi.fn>;
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
