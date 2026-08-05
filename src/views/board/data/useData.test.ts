import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../../lib/core/backlog';
import { loadDashboardBacklogs } from './useData';

const backlog: BacklogItem = {
  id: '42',
  title: 'Fix API',
  dependsOn: [],
  state: 'ready',
  executionMode: 'afk',
  tags: [],
  branchName: 'afk/backlog-42',
  providerRef: 'github:org/repo#42',
};

describe('dashboard backlog data flow', () => {
  it('loads backlog records through the injected read-only management provider', async () => {
    const list = vi.fn(async () => [backlog]);
    const claim = vi.fn();
    const bundle = {
      backlog: {
        get: vi.fn(),
        list,
        initialize: vi.fn(),
        claim,
      },
    };

    await expect(loadDashboardBacklogs(bundle)).resolves.toEqual([
      expect.objectContaining({ id: '42', state: 'ready', executionMode: 'afk' }),
    ]);
    expect(list).toHaveBeenCalledWith(undefined);
    expect(claim).not.toHaveBeenCalled();
  });
});
