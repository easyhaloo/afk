import { describe, expect, it } from 'vitest';
import { gitLabApiUrl, gitLabBaseUrl, gitLabCloneUrl, resolveGitLabProjectKey } from '../src/shared/gitlab-project.js';

describe('GitLab project key resolution', () => {
  it.each([
    ['group/repo', 'gitlab.com', 'group/repo'],
    ['group/subgroup/repo', 'gitlab.com', 'group/subgroup/repo'],
    ['team.platform/subgroup/repo', 'gitlab.com', 'team.platform/subgroup/repo'],
  ])('keeps %s as a GitLab.com namespace path without an explicit provider host', (projectKey, host, projectPath) => {
    expect(resolveGitLabProjectKey(projectKey)).toEqual({ host, projectPath });
  });

  it('uses and strips only an explicit provider host', () => {
    expect(resolveGitLabProjectKey('git.corp/group/subgroup/repo', 'git.corp')).toEqual({
      host: 'git.corp',
      projectPath: 'group/subgroup/repo',
    });
    expect(resolveGitLabProjectKey('team.platform/subgroup/repo', 'git.corp')).toEqual({
      host: 'git.corp',
      projectPath: 'team.platform/subgroup/repo',
    });
  });

  it('builds clone URLs from the explicit provider host', () => {
    expect(gitLabCloneUrl('group/subgroup/repo')).toBe('https://gitlab.com/group/subgroup/repo.git');
    expect(gitLabCloneUrl('git.corp/group/repo', 'git.corp')).toBe('https://git.corp/group/repo.git');
  });
});

describe('GitLab instance URL', () => {
  it('keeps the path an instance is installed under', () => {
    expect(gitLabBaseUrl('https://gitlab.corp/gitlab')).toBe('https://gitlab.corp/gitlab');
    expect(gitLabBaseUrl('gitlab.corp/gitlab')).toBe('https://gitlab.corp/gitlab');
    expect(gitLabBaseUrl('https://gitlab.corp/gitlab/')).toBe('https://gitlab.corp/gitlab');
  });

  it('defaults to gitlab.com', () => {
    expect(gitLabBaseUrl(undefined)).toBe('https://gitlab.com');
    expect(gitLabBaseUrl('')).toBe('https://gitlab.com');
  });

  it('asks an instance under a path for its API under that path', () => {
    expect(gitLabApiUrl(gitLabBaseUrl('https://gitlab.corp/gitlab'), '/api/v4/projects'))
      .toBe('https://gitlab.corp/gitlab/api/v4/projects');
    expect(gitLabApiUrl(gitLabBaseUrl('https://gitlab.com'), '/api/v4/projects'))
      .toBe('https://gitlab.com/api/v4/projects');
  });
});
