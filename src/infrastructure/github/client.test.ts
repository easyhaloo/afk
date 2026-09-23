import { describe, expect, it } from 'vitest';
import { GitHubClient } from './client';

describe('GitHubClient', () => {
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
