import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../../lib/core/backlog';
import { loadBacklogViewModels, toBacklogViewModel } from './backlog-adapter';

const item = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: '42',
  title: 'Implement backlog',
  description: 'Description',
  dependsOn: ['7'],
  state: 'ready',
  executionMode: 'afk',
  parentId: '10',
  tags: ['api'],
  branchName: 'afk/backlog-42',
  providerRef: 'github:org/repo#42',
  webUrl: 'https://github.com/org/repo/issues/42',
  ...overrides,
});

describe('backlog TUI adapter', () => {
  it('maps canonical backlog fields without interpreting provider labels', () => {
    const source = item();
    const viewModel = toBacklogViewModel(source);

    expect(viewModel).toEqual({
      id: '42',
      title: 'Implement backlog',
      description: 'Description',
      state: 'ready',
      executionMode: 'afk',
      parentId: '10',
      dependsOn: ['7'],
      tags: ['api'],
      branchName: 'afk/backlog-42',
      providerRef: 'github:org/repo#42',
      webUrl: 'https://github.com/org/repo/issues/42',
    });
    expect(viewModel).not.toHaveProperty('labels');

    source.dependsOn.push('mutated');
    source.tags.push('mutated');
    expect(viewModel.dependsOn).toEqual(['7']);
    expect(viewModel.tags).toEqual(['api']);
  });

  it('loads view models only through the management backlog list surface', async () => {
    const list = vi.fn(async () => [item(), item({ id: '43', webUrl: undefined })]);
    const bundle = { backlog: { list } } as any;

    await expect(loadBacklogViewModels(bundle, { state: 'ready' })).resolves.toEqual([
      expect.objectContaining({ id: '42', webUrl: 'https://github.com/org/repo/issues/42' }),
      expect.objectContaining({ id: '43', webUrl: undefined }),
    ]);
    expect(list).toHaveBeenCalledWith({ state: 'ready' });
  });
});
