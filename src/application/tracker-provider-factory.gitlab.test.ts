import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getGlabToken: vi.fn(() => ({ host: 'git.corp', apiHost: 'api.git.corp', token: 'secret' })),
  gitLabConfig: undefined as unknown,
}));

vi.mock('../infrastructure/gitlab/glab-config', () => ({
  getGlabToken: mocks.getGlabToken,
  listGlabTokens: vi.fn(() => []),
}));
vi.mock('../infrastructure/gitlab', () => ({
  GitLabClient: class {
    readonly platform = 'gitlab';
    readonly projectId: string;
    constructor(config: unknown) {
      mocks.gitLabConfig = config;
      this.projectId = (config as { projectId: string }).projectId;
    }
  },
}));
vi.mock('../infrastructure/tracker/resolver', () => ({
  resolveGitHubRepository: vi.fn(),
  resolveGitLabProject: vi.fn(async () => { throw new Error('git remote must not be consulted'); }),
  resolveTrackerProject: vi.fn(async () => { throw new Error('platform detection must not run'); }),
}));

import { createTracker } from './tracker-provider-factory';

describe('GitLab tracker factory', () => {
  afterEach(() => {
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_URL;
    vi.clearAllMocks();
    mocks.gitLabConfig = undefined;
  });

  it('uses the preferred self-hosted GitLab host and explicit project id', async () => {
    const tracker = await createTracker('202', '/workspace/repositories/api', 'gitlab', 'git.corp');

    expect(mocks.getGlabToken).toHaveBeenCalledWith('git.corp');
    expect(mocks.gitLabConfig).toEqual({ url: 'https://api.git.corp', token: 'secret', projectId: '202' });
    expect(tracker).toMatchObject({ platform: 'gitlab', projectId: '202' });
  });

  it('keeps the default glab host when no manifest host or environment URL is supplied', async () => {
    await createTracker('202', '/workspace/repositories/api', 'gitlab');
    expect(mocks.getGlabToken).toHaveBeenCalledWith(undefined);
    expect(mocks.gitLabConfig).toEqual({ url: 'https://api.git.corp', token: 'secret', projectId: '202' });
  });

  it('rejects an env token when the manifest host differs from GITLAB_URL', async () => {
    process.env.GITLAB_TOKEN = 'environment-token';
    process.env.GITLAB_URL = 'https://gitlab.com';

    await expect(createTracker('202', '/workspace/repositories/api', 'gitlab', 'attacker.example'))
      .rejects.toThrow(/does not match/i);

    expect(mocks.getGlabToken).not.toHaveBeenCalled();
    expect(mocks.gitLabConfig).toBeUndefined();
  });

  it('allows an env token only for the matching configured host', async () => {
    process.env.GITLAB_TOKEN = 'environment-token';
    process.env.GITLAB_URL = 'https://git.corp';

    await createTracker('202', '/workspace/repositories/api', 'gitlab', 'git.corp');

    expect(mocks.getGlabToken).not.toHaveBeenCalled();
    expect(mocks.gitLabConfig).toEqual({ url: 'https://git.corp', token: 'environment-token', projectId: '202' });
  });

  it('rejects a glab token returned for a different preferred host', async () => {
    mocks.getGlabToken.mockReturnValueOnce({ host: 'git.corp', apiHost: 'api.git.corp', token: 'secret' });

    await expect(createTracker('202', '/workspace/repositories/api', 'gitlab', 'attacker.example'))
      .rejects.toThrow(/matching glab token/i);
  });
});
