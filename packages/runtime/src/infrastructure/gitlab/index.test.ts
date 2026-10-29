import { describe, expect, it, vi } from 'vitest';
import { GitLabClient } from './index.js';

describe('GitLabClient listMRs', () => {
  it('scopes relationship reads to a project on the authenticated host', async () => {
    const client = new GitLabClient({ url: 'https://gitlab.example.test', token: 'token', projectId: 'team/code' });
    const scoped = client.forProject('gitlab.example.test/team/other');
    expect(scoped.projectId).toBe('team/other');
    expect(scoped.providerHost).toBe('gitlab.example.test');
    const show = vi.fn().mockResolvedValue({ iid: 7, title: 'Remote', labels: [], state: 'opened', web_url: 'https://example/7' });
    (scoped as any).client = { Issues: { show } };
    await scoped.getIssue(7);
    expect(show).toHaveBeenCalledWith('team/other', 7);
    expect(() => client.forProject('other.example.test/team/other')).toThrow('cross-host');
  });
  it('checks native closing issues by project ID and IID, failing closed on unreadable data', async () => {
    const client = new GitLabClient({ url: 'https://gitlab.example.test', token: 'token', projectId: 'team/code' });
    const closesIssues = vi.fn().mockResolvedValue([{ project_id: 11, iid: 158 }, { project_id: 22, iid: 158 }]);
    const show = vi.fn().mockResolvedValue({ id: 22 });
    (client as unknown as { client: { MergeRequests: { closesIssues: typeof closesIssues }; Projects: { show: typeof show } } }).client = {
      MergeRequests: { closesIssues }, Projects: { show },
    };
    await expect(client.isMRLinkedToIssue(9, 'gitlab:team/issues#158')).resolves.toBe(true);
    expect(show).toHaveBeenCalledWith('team/issues');
    expect(closesIssues).toHaveBeenCalledWith('team/code', 9);
    show.mockResolvedValue({ id: 33 });
    await expect(client.isMRLinkedToIssue(9, 'gitlab:team/issues#158')).resolves.toBe(false);
    show.mockResolvedValue({});
    await expect(client.isMRLinkedToIssue(9, 'gitlab:team/issues#158')).rejects.toThrow(/unavailable/i);
    show.mockResolvedValue({ id: 22 });
    closesIssues.mockResolvedValue([{ iid: 158 }]);
    await expect(client.isMRLinkedToIssue(9, 'gitlab:team/issues#158')).rejects.toThrow(/unavailable/i);
    closesIssues.mockRejectedValue(new Error('API unavailable'));
    await expect(client.isMRLinkedToIssue(9, 'gitlab:team/issues#158')).rejects.toThrow('API unavailable');
  });

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

describe('GitLabClient linkIssues', () => {
  function linked() {
    const link = vi.fn().mockResolvedValue({});
    const links = vi.fn().mockResolvedValue([]);
    const show = vi.fn().mockResolvedValue({ id: 7752 });
    const client = new GitLabClient({ url: 'https://gitlab.example.test', token: 'token', projectId: 'team/atlas' });
    (client as unknown as { client: { Issues: { link: typeof link; links: typeof links }; Projects: { show: typeof show } } }).client = {
      Issues: { link, links }, Projects: { show },
    };
    return { client, link, links, show };
  }

  it('writes a blocked-by relation as a blocks link that starts at the record it waits for', async () => {
    const { client, link, show } = linked();
    await client.linkIssues(5, 8, 'blocked_by', 'team/k-base');
    // GitLab stores the blocking direction, not the waiting one: the record
    // that waits is the target of a `blocks` link that starts at the record
    // it waits for.
    expect(link).toHaveBeenCalledWith('team/k-base', 8, 7752, 5, { link_type: 'blocks' });
    expect(show).toHaveBeenCalledWith('team/atlas');
  });

  it('keeps the direction of a link that names a blocking relation', async () => {
    const { client, link } = linked();
    await client.linkIssues(5, 8, 'blocks', 'team/k-base');
    expect(link).toHaveBeenCalledWith('team/atlas', 5, 7752, 8, { link_type: 'blocks' });
  });

  it('names the relation the way GitLab names it', async () => {
    const { client, link } = linked();
    await client.linkIssues(5, 8, 'related_to', 'team/k-base');
    expect(link).toHaveBeenCalledWith('team/atlas', 5, 7752, 8, { link_type: 'relates_to' });
  });

  it('does not create a link that is already there', async () => {
    const { client, link, links } = linked();
    links.mockResolvedValue([{ iid: 5, project_id: 7752 }]);
    await client.linkIssues(5, 8, 'blocked_by', 'team/k-base');
    expect(links).toHaveBeenCalledWith('team/k-base', 8);
    expect(link).not.toHaveBeenCalled();
  });

  it('refuses to write a link whose project has no readable identity', async () => {
    const { client, link, show } = linked();
    show.mockResolvedValue({});
    await expect(client.linkIssues(5, 8, 'blocked_by', 'team/k-base')).rejects.toThrow(/unavailable/i);
    expect(link).not.toHaveBeenCalled();
  });
});
