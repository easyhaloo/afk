import { describe, expect, it, vi } from 'vitest';

const getGlabToken = vi.hoisted(() => vi.fn());
vi.mock('../src/infrastructure/gitlab/glab-config', () => ({ getGlabToken }));

import { getGitLabConfig } from '../src/infrastructure/config/manager';

describe('gitlab config', () => {
  it('resolves glab authentication from the infrastructure implementation', () => {
    const originalToken = process.env.GITLAB_TOKEN;
    const originalUrl = process.env.GITLAB_URL;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_URL;
    getGlabToken.mockReturnValueOnce({ apiHost: 'git.corp', token: 'token' });
    try {
      expect(getGitLabConfig()).toEqual({ url: 'https://git.corp', token: 'token' });
      expect(getGlabToken).toHaveBeenCalledWith(undefined);
    } finally {
      if (originalToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = originalToken;
      if (originalUrl === undefined) delete process.env.GITLAB_URL;
      else process.env.GITLAB_URL = originalUrl;
    }
  });
});
