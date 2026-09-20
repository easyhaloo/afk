import { describe, expect, it, vi } from 'vitest';
import { createGlobalWorkItemCatalogs } from './tracker-provider-factory';
import type { ProviderCatalog } from './work-items/types';

describe('global provider catalog factory', () => {
  it('creates a GitHub catalog from credentials without consulting cwd or git remotes', () => {
    const githubCatalog = { platform: 'github', scopeKey: 'github.com' } as ProviderCatalog;
    const createGitHubCatalog = vi.fn(() => githubCatalog);

    const catalogs = createGlobalWorkItemCatalogs('github', {
      env: { GITHUB_TOKEN: 'token' },
      readGhToken: vi.fn(() => null),
      listGlabTokens: vi.fn(() => []),
      createGitHubCatalog,
      createGitLabCatalog: vi.fn(),
    });

    expect(catalogs).toEqual([githubCatalog]);
    expect(createGitHubCatalog).toHaveBeenCalledWith('token');
  });

  it('creates one GitLab catalog for every configured token host', () => {
    const createGitLabCatalog = vi.fn((host: string) => ({ platform: 'gitlab', scopeKey: host } as ProviderCatalog));

    const catalogs = createGlobalWorkItemCatalogs('gitlab', {
      env: {},
      readGhToken: vi.fn(() => null),
      listGlabTokens: vi.fn(() => [
        { host: 'gitlab.com', apiHost: 'gitlab.com', apiProtocol: 'https', token: 'one' },
        { host: 'corp', apiHost: 'gitlab.corp', apiProtocol: 'https', token: 'two' },
      ]),
      createGitHubCatalog: vi.fn(),
      createGitLabCatalog,
    });

    expect(catalogs.map(catalog => catalog.scopeKey)).toEqual(['corp', 'gitlab.com']);
    expect(createGitLabCatalog).toHaveBeenNthCalledWith(1, 'corp', 'https://gitlab.corp', 'two');
    expect(createGitLabCatalog).toHaveBeenNthCalledWith(2, 'gitlab.com', 'https://gitlab.com', 'one');
  });

  it('uses the configured GitLab host as the canonical identity when api_host differs', async () => {
    const catalogs = createGlobalWorkItemCatalogs('gitlab', {
      env: {}, readGhToken: vi.fn(() => null),
      listGlabTokens: vi.fn(() => [{ host: 'git.corp', apiHost: 'api.corp', apiProtocol: 'https', token: 'token' }]),
      createGitHubCatalog: vi.fn(),
      createGitLabCatalog: (host, url) => ({ platform: 'gitlab', scopeKey: host,
        async listProjects() { return [{ platform: 'gitlab', projectKey: `${host}/team/api`, name: url }]; },
        async listIssues() { return []; },
      }),
    });
    expect((await catalogs[0].listProjects())[0].projectKey).toBe('git.corp/team/api');
  });

  it('fails with an authentication error when the requested platform has no credentials', () => {
    expect(() => createGlobalWorkItemCatalogs('github', {
      env: {},
      readGhToken: vi.fn(() => null),
      listGlabTokens: vi.fn(() => []),
      createGitHubCatalog: vi.fn(),
      createGitLabCatalog: vi.fn(),
    })).toThrow('GitHub authentication is required');
  });
});
