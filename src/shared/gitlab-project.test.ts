import { describe, expect, it } from 'vitest';
import { gitLabCloneUrl, resolveGitLabProjectKey } from './gitlab-project';

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
