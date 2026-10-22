import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  resolveRemoteTarget: vi.fn(async (): Promise<{ platform: 'github' | 'gitlab'; projectId: string } | null> => null),
}));

vi.mock('../tracker/resolver.js', () => ({
  resolveGitHubRepository: vi.fn(async () => null),
  resolveGitLabProject: vi.fn(async () => null),
  resolveRemoteTarget: mocks.resolveRemoteTarget,
}));

import { createGlobalWorkItemCatalogs, createTracker } from './tracker-provider-factory.js';
import type { ProviderCatalog } from '../../domain/work-item/provider-types.js';

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

describe('tracker target resolution outside a git repository', () => {
  let stateRoot: string;
  let previousStateRoot: string | undefined;

  beforeEach(() => {
    // The local tracker index is machine state; the tests must not read it.
    stateRoot = mkdtempSync(join(tmpdir(), 'afk-tracker-factory-'));
    previousStateRoot = process.env.AFK_STATE_DIR;
    process.env.AFK_STATE_DIR = stateRoot;
  });

  afterEach(() => {
    rmSync(stateRoot, { recursive: true, force: true });
    if (previousStateRoot === undefined) delete process.env.AFK_STATE_DIR;
    else process.env.AFK_STATE_DIR = previousStateRoot;
    delete process.env.GITHUB_TOKEN;
    delete process.env.AFK_TRACKER_PROJECT;
    mocks.resolveRemoteTarget.mockReset();
    mocks.resolveRemoteTarget.mockResolvedValue(null);
  });

  it('creates a tracker from an explicit project when the directory has no remote', async () => {
    process.env.GITHUB_TOKEN = 'token';

    const tracker = await createTracker('owner/repo', '/nowhere');

    expect(tracker).toMatchObject({ platform: 'github', projectId: 'owner/repo' });
  });

  it('creates a tracker from AFK_TRACKER_PROJECT when the directory has no remote', async () => {
    process.env.GITHUB_TOKEN = 'token';
    process.env.AFK_TRACKER_PROJECT = 'owner/repo';

    const tracker = await createTracker(undefined, '/nowhere');

    expect(tracker).toMatchObject({ platform: 'github', projectId: 'owner/repo' });
  });

  it('reports the remote target when the directory is a git repository', async () => {
    process.env.GITHUB_TOKEN = 'token';
    mocks.resolveRemoteTarget.mockResolvedValue({ platform: 'github', projectId: 'team/repo' });

    const tracker = await createTracker(undefined, '/repo');

    expect(tracker).toMatchObject({ platform: 'github', projectId: 'team/repo' });
  });
});
