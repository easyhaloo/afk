import { describe, expect, it, vi } from 'vitest';
import { GitHubProviderCatalog, GitLabProviderCatalog } from './catalogs';

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
    };
    const catalog = new GitHubProviderCatalog(client, 1);
    const projects = await catalog.listProjects();
    const issues = await catalog.listIssues(projects.items[0]);

    expect(projects.items.map(project => project.projectKey)).toEqual(['acme/api']);
    expect(projects.error).toMatchObject({ message: 'HTTP 503 projects' });
    expect(issues.items.map(issue => issue.issueNumber)).toEqual([4]);
    expect(issues.error).toMatchObject({ message: 'HTTP 503 issues' });
  });
});
