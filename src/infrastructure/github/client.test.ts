import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './client';

describe('GitHubClient', () => {
  it('reads issue-side linked PRs across repositories and pages', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const graphql = vi.fn().mockResolvedValueOnce({ repository: { issue: { closedByPullRequestsReferences: {
      nodes: [{ number: 9, repository: { nameWithOwner: 'owner/other' } }], pageInfo: { hasNextPage: true, endCursor: 'next' },
    } } } }).mockResolvedValueOnce({ repository: { issue: { closedByPullRequestsReferences: {
      nodes: [{ number: 9, repository: { nameWithOwner: 'owner/code' } }], pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
    (client as unknown as { client: { graphql: typeof graphql } }).client = { graphql };
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).resolves.toBe(true);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining('closedByPullRequestsReferences'), expect.objectContaining({ owner: 'owner', repo: 'issues', number: 158, after: 'next' }));
    graphql.mockResolvedValue({ repository: null });
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).rejects.toThrow(/unavailable/i);
  });

  it('rejects same-number PRs from another repository and missing cursor data', async () => {
    const client = new GitHubClient({ repo: 'owner/code', auth: 'test-token' });
    const graphql = vi.fn().mockResolvedValue({ repository: { issue: { closedByPullRequestsReferences: {
      nodes: [{ number: 9, repository: { nameWithOwner: 'owner/other' } }], pageInfo: { hasNextPage: false, endCursor: null },
    } } } });
    (client as unknown as { client: { graphql: typeof graphql } }).client = { graphql };
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).resolves.toBe(false);
    graphql.mockResolvedValue({ repository: { issue: { closedByPullRequestsReferences: {
      nodes: [], pageInfo: { hasNextPage: true, endCursor: null },
    } } } });
    await expect(client.isMRLinkedToIssue(9, 'github:owner/issues#158')).rejects.toThrow(/cursor unavailable/i);
  });

  it('requires authentication before constructing a client', () => {
    expect(() => new GitHubClient({ repo: 'owner/repo' })).toThrow(/requires auth token/);
  });

  it('extracts label acceptance criteria for the configured repository', () => {
    const client = new GitHubClient({ repo: 'owner/repo', auth: 'test-token' });
    expect(client.projectId).toBe('owner/repo');
    expect(client.parseAC({ labels: ['ac::1::Checks pass'], description: '## AC\n- [ ] Ignored fallback' }))
      .toEqual({ source: 'labels', items: [{ index: 1, text: 'Checks pass', evidenceType: 'none', checkCommand: '' }] });
  });
});
