import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from '../src/provider/github-client.js';

describe('GitHubClient', () => {
  it('reads the PR-side closing issue references for open PRs', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const graphql = vi.fn().mockResolvedValue({ repository: { pullRequest: { closingIssuesReferences: {
      nodes: [{ number: 158, repository: { nameWithOwner: 'owner/issues' } }],
    } } } });
    (client as unknown as { client: { graphql: typeof graphql } }).client = { graphql };
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).resolves.toBe(true);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('closingIssuesReferences'), expect.objectContaining({ owner: 'owner', repo: 'code', pullRequest: 9 }));
    graphql.mockResolvedValue({ repository: null });
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).rejects.toThrow(/unavailable/i);
  });

  it('rejects references to another issue or repository', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const graphql = vi.fn().mockResolvedValue({ repository: { pullRequest: { closingIssuesReferences: {
      nodes: [{ number: 9, repository: { nameWithOwner: 'owner/other' } }],
    } } } });
    (client as unknown as { client: { graphql: typeof graphql } }).client = { graphql };
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).resolves.toBe(false);
    graphql.mockResolvedValue({ repository: { pullRequest: { closingIssuesReferences: { nodes: [] } } } });
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).resolves.toBe(false);
  });

  it('requires authentication before constructing a client', () => {
    expect(() => new GitHubClient({ repo: 'owner/repo' })).toThrow(/requires auth token/);
  });

  it('reads every page of issues, not only the first', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const request = vi.fn(async (_route: string, params: { page?: number }) => {
      if ((params.page ?? 1) === 1) {
        return { data: [1, 2].map((number) => ({ number, title: `Issue ${number}`, body: '', labels: [], state: 'open', html_url: `https://github.com/owner/code/issues/${number}` })) };
      }
      return { data: [{ number: 3, title: 'Issue 3', body: '', labels: [], state: 'open', html_url: 'https://github.com/owner/code/issues/3' }] };
    });
    (client as unknown as { client: { request: typeof request } }).client = { request };

    const issues = await client.listIssues({ state: 'all', perPage: 2 });

    expect(issues.map((issue) => issue.id)).toEqual([1, 2, 3]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('reads every page of merge requests, not only the first', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const list = vi.fn(async (_params: { page?: number }) => {
      if ((_params.page ?? 1) === 1) {
        return { data: [1, 2].map((number) => ({ number, title: `PR ${number}`, state: 'open', head: { ref: 'afk/backlog-1' }, base: { ref: 'main' }, html_url: `https://github.com/owner/code/pull/${number}` })) };
      }
      return { data: [{ number: 3, title: 'PR 3', state: 'open', head: { ref: 'afk/backlog-3' }, base: { ref: 'main' }, html_url: 'https://github.com/owner/code/pull/3' }] };
    });
    (client as unknown as { client: { pulls: { list: typeof list } } }).client = { pulls: { list } };

    const changes = await client.listMRs({ state: 'all', perPage: 2 });

    expect(changes.map((change) => change.id)).toEqual([1, 2, 3]);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('tells a merged pull request from a closed one in the list', async () => {
    // The list answer carries `merged_at` and not the `merged` flag the
    // single read carries. A pull request GitHub has merged is closed as
    // well, so without the timestamp it reads as a plain closed one.
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const list = vi.fn(async () => ({
      data: [
        { number: 1, title: 'merged', state: 'closed', merged_at: '2026-09-01T00:00:00.000Z', head: { ref: 'afk/1' }, base: { ref: 'main' }, html_url: 'https://github.com/owner/code/pull/1' },
        { number: 2, title: 'closed', state: 'closed', merged_at: null, head: { ref: 'afk/2' }, base: { ref: 'main' }, html_url: 'https://github.com/owner/code/pull/2' },
      ],
    }));
    (client as unknown as { client: { pulls: { list: typeof list } } }).client = { pulls: { list } };

    const changes = await client.listMRs({ state: 'all' });

    expect(changes.map(change => change.state)).toEqual(['merged', 'closed']);
  });

  it('reads every page of issue comments, not only the first', async () => {    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const listComments = vi.fn(async (_params: { page?: number }) => {
      if ((_params.page ?? 1) === 1) {
        return { data: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, body: `comment ${index + 1}` })) };
      }
      return { data: [{ id: 101, body: 'comment 101' }] };
    });
    (client as unknown as { client: { issues: { listComments: typeof listComments } } }).client = { issues: { listComments } };

    const comments = await client.listIssueComments(7);

    expect(comments).toHaveLength(101);
    expect(comments[100]).toEqual({ id: '101', body: 'comment 101' });
    expect(listComments).toHaveBeenCalledTimes(2);
  });

  it('reads every page of branches and tags, not only the first', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const listBranches = vi.fn(async (_params: { page?: number }) => (
      (_params.page ?? 1) === 1
        ? { data: Array.from({ length: 100 }, (_, index) => ({ name: `branch-${index}`, commit: { sha: 'abcdef1234567890' }, protected: false })) }
        : { data: [{ name: 'branch-100', commit: { sha: 'abcdef1234567890' }, protected: false }] }
    ));
    const listTags = vi.fn(async (_params: { page?: number }) => (
      (_params.page ?? 1) === 1
        ? { data: Array.from({ length: 100 }, (_, index) => ({ name: `v1.0.${index}`, commit: { sha: 'abcdef1234567890' } })) }
        : { data: [{ name: 'v1.0.20', commit: { sha: 'abcdef1234567890' } }] }
    ));
    (client as unknown as { client: { repos: { listBranches: typeof listBranches, listTags: typeof listTags } } }).client = { repos: { listBranches, listTags } };

    expect(await client.getBranches(1)).toHaveLength(101);
    expect(await client.getTags(1)).toHaveLength(101);
    expect(listBranches).toHaveBeenCalledTimes(2);
    expect(listTags).toHaveBeenCalledTimes(2);
  });

  it('does not offer artifact upload, because GitHub has nowhere to put it', () => {
    const client = new GitHubClient({ repo: 'owner/repo', auth: 'test-token' });
    // The interface says the capability is optional and that GitHub does
    // not offer it.  A method that returns an empty string is not an
    // offer — it is a promise the adapter cannot keep.
    expect('uploadArtifacts' in client).toBe(false);
  });
});
