import { describe, expect, it } from 'vitest';
import {
  InMemoryBacklogProvider,
  deriveBacklogBranchName,
  type BacklogItem,
} from './index';

const item = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: '123',
  title: 'Implement item',
  dependsOn: [],
  state: 'ready',
  executionMode: 'afk',
  tags: [],
  branchName: 'afk/backlog-123',
  providerRef: 'issue:123',
  ...overrides,
});

describe('backlog provider', () => {
  it('derives stable safe branch names from backlog IDs', () => {
    expect(deriveBacklogBranchName('123')).toBe('afk/backlog-123');
    expect(deriveBacklogBranchName('ENG/42')).toBe('afk/backlog-eng-42');
    expect(() => deriveBacklogBranchName('')).toThrow('backlog id');
  });

  it('allows a parent backlog to run after every child backlog is done', async () => {
    const provider = new InMemoryBacklogProvider([
      item({ id: 'parent', branchName: 'afk/backlog-parent' }),
      item({ id: 'child', parentId: 'parent' }),
    ]);

    expect(await provider.isRunnable(await provider.get('parent'))).toBe(false);
    await provider.transition('child', 'done');
    expect(await provider.isRunnable(await provider.get('parent'))).toBe(true);
  });

  it('waits for every dependency to be done', async () => {
    const provider = new InMemoryBacklogProvider([
      item({ id: 'dep', branchName: 'afk/backlog-dep' }),
      item({ id: 'child', dependsOn: ['dep'] }),
    ]);

    expect(await provider.isRunnable(await provider.get('child'))).toBe(false);
    await provider.transition('dep', 'done');
    expect(await provider.isRunnable(await provider.get('child'))).toBe(true);
  });

  it('atomically allows only one owner to claim an item', async () => {
    const provider = new InMemoryBacklogProvider([item()]);
    const [first, second] = await Promise.all([
      provider.claim('123', 'worker-a'),
      provider.claim('123', 'worker-b'),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((await provider.get('123')).state).toBe('in_progress');
  });

  it('marks automation failures as blocked and hitl', async () => {
    const provider = new InMemoryBacklogProvider([item()]);
    await provider.transition('123', 'blocked', { reason: 'timeout' });
    await provider.setExecutionMode('123', 'hitl');
    await expect(provider.get('123')).resolves.toMatchObject({ state: 'blocked', executionMode: 'hitl' });
  });

  it('claims an AFK rework item on its original backlog branch', async () => {
    const provider = new InMemoryBacklogProvider([item({ state: 'rework', branchName: 'afk/backlog-123' })]);

    await expect(provider.claim('123', 'worker-a')).resolves.toMatchObject({
      item: { id: '123', state: 'in_progress', branchName: 'afk/backlog-123' },
    });
  });

  it('keeps QA rework history and resolves only the active record', async () => {
    const provider = new InMemoryBacklogProvider([item({ state: 'verification' })]);
    const first = await provider.createRework('123', {
      source: 'qa', summary: 'first integration defect',
      failedCriteria: [{ id: 'first', expected: 'works', actual: 'fails' }], requiredChecks: [],
    });
    await provider.resolveRework('123', first.id, { summary: 'first defect verified' });
    const second = await provider.createRework('123', {
      source: 'qa', summary: 'new integration defect',
      failedCriteria: [{ id: 'second', expected: 'works', actual: 'fails' }], requiredChecks: [],
    });

    expect(first).toMatchObject({ id: 'r1', status: 'open' });
    expect(second).toMatchObject({ id: 'r2', attempt: 2, status: 'open' });
    await expect(provider.getActiveRework('123')).resolves.toMatchObject({ id: 'r2', summary: 'new integration defect' });
  });

  it('supports provider-neutral business tags and tag filtering', async () => {
    const provider = new InMemoryBacklogProvider([item({ tags: ['api', 'urgent'] })]);
    expect(await provider.list({ tag: 'api' })).toHaveLength(1);
    await provider.addTag('123', 'frontend');
    await provider.addTag('123', 'frontend');
    await expect(provider.get('123')).resolves.toMatchObject({ tags: ['api', 'urgent', 'frontend'] });
    await provider.removeTag('123', 'urgent');
    await expect(provider.get('123')).resolves.toMatchObject({ tags: ['api', 'frontend'] });
  });
});
