import { describe, expect, it, vi } from 'vitest';
import { GitHubProviderCatalog, GitLabProviderCatalog } from '../src/provider/catalogs.js';

describe('provider catalogs', () => {
  it('enumerates GitHub repositories and issues across every page', async () => {
    const listProjectsPage = vi.fn(async (page: number) => page === 1 ? [
      { id: 1, fullName: 'acme/api', name: 'api', defaultBranch: 'main', webUrl: 'https://github.com/acme/api' },
      { id: 2, fullName: 'acme/web', name: 'web', defaultBranch: 'main', webUrl: 'https://github.com/acme/web' },
    ] : page === 2 ? [
      { id: 3, fullName: 'tools/cli', name: 'cli', defaultBranch: 'trunk', webUrl: 'https://github.com/tools/cli' },
    ] : []);
    const listIssuesPage = vi.fn(async (_project: string, page: number) => page === 1 ? [
      { number: 1, title: 'first', body: null, labels: ['bug'], state: 'open' as const, webUrl: 'https://example/1' },
      { number: 2, title: 'pull request', body: '', labels: [], state: 'open' as const, webUrl: 'https://example/2', pullRequest: true },
    ] : page === 2 ? [
      { number: 3, title: 'third', body: 'body', labels: [], state: 'closed' as const, webUrl: 'https://example/3' },
    ] : []);
    const catalog = new GitHubProviderCatalog({ listProjectsPage, listIssuesPage }, 2);

    const projects = await catalog.listProjects();
    const issues = await catalog.listIssues(projects[0]);

    expect(projects.map(project => project.projectKey)).toEqual(['acme/api', 'acme/web', 'tools/cli']);
    expect(issues.map(issue => issue.issueNumber)).toEqual([1, 3]);
    expect(listProjectsPage).toHaveBeenCalledTimes(2);
    expect(listIssuesPage).toHaveBeenCalledTimes(2);
  });

  it('enumerates membership projects and issues for an enterprise GitLab host', async () => {
    const listProjectsPage = vi.fn(async (page: number) => page === 1 ? [
      { id: 21, pathWithNamespace: 'platform/api', name: 'api', defaultBranch: 'main', webUrl: 'https://gitlab.corp/platform/api' },
    ] : []);
    const listIssuesPage = vi.fn(async (_projectId: string, page: number) => page === 1 ? [
      { iid: 4, title: 'first', description: null, labels: ['stage::rework', 'mode::afk'], state: 'opened' as const, webUrl: 'https://gitlab.corp/platform/api/-/issues/4' },
    ] : []);
    const catalog = new GitLabProviderCatalog('gitlab.corp', { listProjectsPage, listIssuesPage }, 100);

    const projects = await catalog.listProjects();
    const issues = await catalog.listIssues(projects[0]);

    expect(projects).toEqual([expect.objectContaining({
      platform: 'gitlab',
      projectKey: 'gitlab.corp/platform/api',
      providerHost: 'gitlab.corp',
      providerProjectId: '21',
    })]);
    expect(issues).toEqual([expect.objectContaining({ issueNumber: 4, state: 'opened' })]);
    expect(listProjectsPage).toHaveBeenCalledWith(1, 100);
    expect(listIssuesPage).toHaveBeenCalledWith('21', 1, 100);
  });

  it('preserves completed GitHub project and issue pages when a later page fails', async () => {
    const client = {
      listProjectsPage: vi.fn(async (page: number) => {
        if (page === 2) throw new Error('HTTP 503 projects');
        return [{ id: 1, fullName: 'acme/api', name: 'api' }];
      }),
      listIssuesPage: vi.fn(async (_key: string, page: number) => {
        if (page === 2) throw new Error('HTTP 503 issues');
        return [{ number: 4, title: 'first', body: null, labels: [], state: 'open' as const }];
      }),
      listIssuesByOwnerPage: vi.fn(async () => ({ items: [], totalCount: 0 })),
    };
    const catalog = new GitHubProviderCatalog(client, 1);
    const projects = await catalog.listProjects();
    const issues = await catalog.listIssues(projects.items[0]);

    expect(projects.items.map(project => project.projectKey)).toEqual(['acme/api']);
    expect(projects.error).toMatchObject({ message: 'HTTP 503 projects' });
    expect(issues.items.map(issue => issue.issueNumber)).toEqual([4]);
    expect(issues.error).toMatchObject({ message: 'HTTP 503 issues' });
  });

  it('lists the whole GitHub scope with one search per owner', async () => {
    const listIssuesByOwnerPage = vi.fn(async (owner: string, page: number) => {
      if (owner === 'acme') {
        return page === 1
          ? { totalCount: 3, items: [
            { number: 1, title: 'first', body: 'b', labels: ['mode::afk'], state: 'open' as const, projectKey: 'acme/api' },
            { number: 2, title: 'pull request', body: '', labels: [], state: 'open' as const, pullRequest: true, projectKey: 'acme/api' },
          ] }
          : { totalCount: 3, items: [
            { number: 3, title: 'third', body: null, labels: [], state: 'closed' as const, projectKey: 'acme/api' },
          ] };
      }
      return { totalCount: 1, items: [
        { number: 9, title: 'other owner', body: null, labels: [], state: 'open' as const, projectKey: 'tools/cli' },
        { number: 10, title: 'outside the scope', body: null, labels: [], state: 'open' as const, projectKey: 'other/repo' },
      ] };
    });
    const catalog = new GitHubProviderCatalog({
      listProjectsPage: vi.fn(async () => []),
      listIssuesPage: vi.fn(async () => []),
      listIssuesByOwnerPage,
    }, 2);
    const projects = [
      { platform: 'github' as const, projectKey: 'acme/api', providerProjectId: '1', name: 'api' },
      { platform: 'github' as const, projectKey: 'tools/cli', providerProjectId: '2', name: 'cli' },
    ];

    const scoped = await catalog.listIssuesAcrossScope(projects);

    expect(listIssuesByOwnerPage).toHaveBeenCalledWith('acme', 1, 2);
    expect(listIssuesByOwnerPage).toHaveBeenCalledWith('tools', 1, 2);
    expect(scoped.map(entry => `${entry.project.projectKey}#${entry.issue.issueNumber}`)).toEqual([
      'acme/api#1', 'acme/api#3', 'tools/cli#9',
    ]);
  });

  it('fails the GitHub scope listing when the match count exceeds the search limit', async () => {
    const catalog = new GitHubProviderCatalog({
      listProjectsPage: vi.fn(async () => []),
      listIssuesPage: vi.fn(async () => []),
      listIssuesByOwnerPage: vi.fn(async () => ({ items: [], totalCount: 1001 })),
    }, 100);

    const scoped = await catalog.listIssuesAcrossScope([
      { platform: 'github' as const, projectKey: 'acme/api', providerProjectId: '1', name: 'api' },
    ]);

    expect(Array.isArray(scoped)).toBe(false);
    expect((scoped as { error: Error }).error).toMatchObject({ message: /exceeds 1000 matches/ });
  });

  it('lists the whole GitLab scope from the global issue feed', async () => {
    const listIssuesAcrossScopePage = vi.fn(async (page: number) => page === 1 ? [
      { iid: 4, title: 'first', description: null, labels: ['mode::afk'], state: 'opened' as const, webUrl: 'https://gitlab.corp/a/-/issues/4', projectId: '21' },
      { iid: 5, title: 'outside the scope', description: null, labels: [], state: 'opened' as const, projectId: '99' },
    ] : []);
    const catalog = new GitLabProviderCatalog('gitlab.corp', {
      listProjectsPage: vi.fn(async () => []),
      listIssuesPage: vi.fn(async () => []),
      listIssuesAcrossScopePage,
    }, 100);

    const scoped = await catalog.listIssuesAcrossScope([
      { platform: 'gitlab' as const, projectKey: 'gitlab.corp/platform/api', providerHost: 'gitlab.corp', providerProjectId: '21', name: 'api' },
    ]);

    expect(listIssuesAcrossScopePage).toHaveBeenCalledWith(1, 100);
    expect(scoped.map(entry => `${entry.project.projectKey}#${entry.issue.issueNumber}`)).toEqual(['gitlab.corp/platform/api#4']);
  });
});
