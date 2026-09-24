import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGlabToken: vi.fn(),
  listProjects: vi.fn(),
  config: undefined as unknown,
}));

vi.mock('../../../infrastructure/tracker/resolver', () => ({ resolveGitLabProject: vi.fn(async () => null) }));
vi.mock('../../../infrastructure/gitlab/glab-config', () => ({ getGlabToken: mocks.getGlabToken }));
vi.mock('../../../infrastructure/gitlab', () => ({
  GitLabClient: class {
    constructor(config: unknown) { mocks.config = config; }
    listProjects = mocks.listProjects;
  },
}));

import { fetchGitLabProjects } from './fetcher';

describe('dashboard GitLab project fetch', () => {
  afterEach(() => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_URL;
    vi.clearAllMocks();
    mocks.config = undefined;
  });

  it('uses the infrastructure client and glab authentication for project listing', async () => {
    mocks.getGlabToken.mockReturnValueOnce({ host: 'gitlab.com', apiHost: 'gitlab.com', token: 'token' });
    mocks.listProjects.mockResolvedValueOnce([{ id: 1, name: 'repo', platform: 'gitlab' }]);

    await expect(fetchGitLabProjects({ page: 2, perPage: 3 })).resolves.toEqual({
      projects: [{ id: 1, name: 'repo', platform: 'gitlab' }], hasMore: false,
    });
    expect(mocks.getGlabToken).toHaveBeenCalledWith('https://gitlab.com');
    expect(mocks.config).toEqual({ url: 'https://gitlab.com', token: 'token', projectId: 'glab' });
    expect(mocks.listProjects).toHaveBeenCalledWith({ page: 2, perPage: 3 });
  });
});
