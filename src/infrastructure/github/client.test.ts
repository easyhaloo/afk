import { describe, expect, it, vi } from 'vitest';
import { GitHubClient } from './client.js';

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

  it('extracts label acceptance criteria for the configured repository', () => {
    const client = new GitHubClient({ repo: 'owner/repo', auth: 'test-token' });
    expect(client.projectId).toBe('owner/repo');
    expect(client.parseAC({ labels: ['ac::1::Checks pass'], description: '## AC\n- [ ] Ignored fallback' }))
      .toEqual({ source: 'labels', items: [{ index: 1, text: 'Checks pass', evidenceType: 'none', checkCommand: '' }] });
  });
});
