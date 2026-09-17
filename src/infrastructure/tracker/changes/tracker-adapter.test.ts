import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../../domain/backlog';
import type { TrackerProvider } from '../../../domain/tracker/types';
import { TrackerChangeProvider } from './tracker-adapter';

describe('TrackerChangeProvider', () => {
  it('finds a merged backlog change from the all-state listing and refreshes its true state', async () => {
    const tracker = {
      listMRs: vi.fn().mockResolvedValue([{
        id: 9,
        state: 'closed',
        sourceBranch: 'afk/backlog-42',
        targetBranch: 'main',
      }]),
      getMR: vi.fn().mockResolvedValue({
        id: 9,
        state: 'merged',
        sourceBranch: 'afk/backlog-42',
        targetBranch: 'main',
        mergeable: true,
        url: 'https://example.test/mr/9',
      }),
    } as unknown as TrackerProvider;
    const backlog = { id: '42', branchName: 'afk/backlog-42' } as BacklogItem;

    await expect(new TrackerChangeProvider(tracker).findForBacklog(backlog)).resolves.toMatchObject({
      id: '9',
      state: 'merged',
      mergeable: true,
    });
    expect(tracker.listMRs).toHaveBeenCalledWith({ state: 'all' });
    expect(tracker.getMR).toHaveBeenCalledWith(9);
  });
});
