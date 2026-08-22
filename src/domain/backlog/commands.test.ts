import { describe, expect, it, vi } from 'vitest';
import { createBacklog } from './commands';
import type { BacklogManagementProvider } from './index';

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
});
