import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveRemoteTarget: vi.fn(async (): Promise<{ platform: 'github' | 'gitlab'; projectId: string; host?: string } | null> => null),
}));

vi.mock('./resolver.js', () => ({
  resolveRemoteTarget: mocks.resolveRemoteTarget,
}));

import { inferPlatformFromProject, resolveTrackerTarget } from './target.js';
import type { TrackerStore } from './store.js';

const emptyStore: TrackerStore = { version: 1, projects: {} };

function indexStore(): TrackerStore {
  return {
    version: 1,
    projects: {
      'github::owner/repo': {
        platform: 'github',
        project: 'owner/repo',
        paths: ['/workspace/repo'],
        issues: { '229': { seenAt: '2026-10-22T10:00:00.000Z' } },
        updatedAt: '2026-10-22T10:00:00.000Z',
      },
      'gitlab:git.corp:team/api': {
        platform: 'gitlab',
        project: 'team/api',
        host: 'git.corp',
        paths: ['/workspace/api'],
        issues: { '7': { seenAt: '2026-10-22T10:00:00.000Z' } },
        updatedAt: '2026-10-22T10:00:00.000Z',
      },
    },
  };
}

describe('tracker target resolution', () => {
  beforeEach(() => {
    mocks.resolveRemoteTarget.mockReset();
    mocks.resolveRemoteTarget.mockResolvedValue(null);
  });

  it('resolves an explicit target without consulting git', async () => {
    const target = await resolveTrackerTarget({
      project: 'owner/repo',
      platform: 'github',
      cwd: '/nowhere',
      env: {},
      store: emptyStore,
    });

    expect(target).toEqual({
      platform: 'github',
      projectId: 'owner/repo',
      host: undefined,
      platformSource: 'flag',
      projectSource: 'flag',
    });
    expect(mocks.resolveRemoteTarget).not.toHaveBeenCalled();
  });

  it('resolves the target from the environment outside a git repository', async () => {
    const target = await resolveTrackerTarget({
      cwd: '/nowhere',
      env: { AFK_TRACKER_PROJECT: 'group/sub/project', AFK_TRACKER_PLATFORM: 'gitlab' },
      store: emptyStore,
    });

    expect(target).toMatchObject({
      platform: 'gitlab',
      projectId: 'group/sub/project',
      platformSource: 'env',
      projectSource: 'env',
    });
  });

  it('resolves an issue id to the project the local index recorded for it', async () => {
    const target = await resolveTrackerTarget({
      issueId: '229',
      cwd: '/nowhere',
      env: {},
      store: indexStore(),
    });

    expect(target).toMatchObject({
      platform: 'github',
      projectId: 'owner/repo',
      platformSource: 'index',
      projectSource: 'index',
    });
  });

  it('resolves a working directory to the project the local index recorded for it', async () => {
    const target = await resolveTrackerTarget({
      cwd: '/workspace/api',
      env: {},
      store: indexStore(),
    });

    expect(target).toMatchObject({
      platform: 'gitlab',
      projectId: 'team/api',
      host: 'git.corp',
      platformSource: 'index-path',
      projectSource: 'index-path',
    });
  });

  it('prefers an explicit project over the local index', async () => {
    const target = await resolveTrackerTarget({
      project: 'other/project',
      issueId: '229',
      cwd: '/workspace/repo',
      env: {},
      store: indexStore(),
    });

    expect(target).toMatchObject({ projectId: 'other/project', projectSource: 'flag' });
  });

  it('prefers the local index over the environment', async () => {
    const target = await resolveTrackerTarget({
      issueId: '229',
      cwd: '/nowhere',
      env: { AFK_TRACKER_PROJECT: 'other/project' },
      store: indexStore(),
    });

    expect(target).toMatchObject({ projectId: 'owner/repo', projectSource: 'index' });
  });

  it('falls back to the git remote when nothing else names a project', async () => {
    mocks.resolveRemoteTarget.mockResolvedValue({ platform: 'github', projectId: 'team/repo', host: 'github.com' });

    const target = await resolveTrackerTarget({ cwd: '/repo', env: {}, store: emptyStore });

    expect(target).toMatchObject({
      platform: 'github',
      projectId: 'team/repo',
      platformSource: 'remote',
      projectSource: 'remote',
    });
  });

  it('adopts the recorded platform of an explicitly named project', async () => {
    const target = await resolveTrackerTarget({
      project: 'team/api',
      cwd: '/nowhere',
      env: {},
      store: indexStore(),
    });

    expect(target).toMatchObject({ platform: 'gitlab', projectId: 'team/api', host: 'git.corp' });
  });

  it('fails with an actionable error when no target can be resolved', async () => {
    await expect(resolveTrackerTarget({ cwd: '/nowhere', env: {}, store: emptyStore })).rejects.toThrow(
      /A tracker project must be resolved/,
    );
  });
});

describe('platform inference from a project key', () => {
  it('reads numeric keys and namespaced paths as GitLab', () => {
    expect(inferPlatformFromProject('202')).toBe('gitlab');
    expect(inferPlatformFromProject('group/sub/project')).toBe('gitlab');
  });

  it('reads an owner/repo key as GitHub unless only GitLab is configured', () => {
    expect(inferPlatformFromProject('owner/repo')).toBe('github');
    expect(inferPlatformFromProject('owner/repo', { github: true, gitlab: true })).toBe('github');
    expect(inferPlatformFromProject('owner/repo', { github: false, gitlab: true })).toBe('gitlab');
  });
});
