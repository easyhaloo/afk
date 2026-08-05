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

  it('does not consider a parent backlog runnable', async () => {
    const provider = new InMemoryBacklogProvider([
      item({ id: 'parent', branchName: 'afk/backlog-parent' }),
      item({ id: 'child', parentId: 'parent' }),
    ]);

    expect(await provider.isRunnable(await provider.get('parent'))).toBe(false);
    expect(await provider.isRunnable(await provider.get('child'))).toBe(true);
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
