import { describe, expect, it, vi } from 'vitest';
import { GitLabClient } from './index';

describe('GitLabClient listMRs', () => {
  it('passes the all-state filter through so merged changes remain discoverable', async () => {
    const client = new GitLabClient({ url: 'https://gitlab.example.test', token: 'token', projectId: 'group/project' });
    const all = vi.fn().mockImplementation(async ({ state }: { state: string }) => state === 'merged' ? [{
        iid: 9,
        title: 'Merged change',
        state: 'merged',
        source_branch: 'afk/backlog-42',
        target_branch: 'main',
        web_url: 'https://gitlab.example.test/group/project/-/merge_requests/9',
      }] : []);
    (client as unknown as { client: { MergeRequests: { all: typeof all } } }).client = { MergeRequests: { all } };

    await expect(client.listMRs({ state: 'all' })).resolves.toMatchObject([{ id: 9, state: 'merged' }]);
    expect(all).toHaveBeenCalledTimes(3);
    for (const state of ['opened', 'closed', 'merged']) {
      expect(all).toHaveBeenCalledWith(expect.objectContaining({ state }));
    }
  });

  it('maps the provider merge status into a mergeability signal', async () => {
    const client = new GitLabClient({ url: 'https://gitlab.example.test', token: 'token', projectId: 'group/project' });
    const show = vi.fn().mockResolvedValue({
      iid: 9,
      title: 'Blocked change',
      state: 'opened',
      source_branch: 'afk/backlog-42',
      target_branch: 'main',
      web_url: 'https://gitlab.example.test/group/project/-/merge_requests/9',
      detailed_merge_status: 'conflict',
    });
    (client as unknown as { client: { MergeRequests: { show: typeof show } } }).client = { MergeRequests: { show } };

    await expect(client.getMR(9)).resolves.toMatchObject({ mergeable: false });
  });
});
