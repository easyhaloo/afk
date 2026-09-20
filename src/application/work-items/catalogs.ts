import type { ProviderProjectRef } from '../../domain/work-item/types';
import type { CatalogPageResult, ProviderCatalog, ProviderIssue } from './types';

export interface GitHubCatalogProject {
  id: number;
  fullName: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
}

export interface GitHubCatalogIssue {
  number: number;
  title: string;
  body: string | null;
  labels: string[];
  state: 'open' | 'closed';
  webUrl?: string;
  pullRequest?: boolean;
}

export interface GitHubCatalogPageClient {
  listProjectsPage(page: number, perPage: number): Promise<GitHubCatalogProject[]>;
  listIssuesPage(projectKey: string, page: number, perPage: number): Promise<GitHubCatalogIssue[]>;
}

export class GitHubProviderCatalog implements ProviderCatalog {
  readonly platform = 'github' as const;
  readonly scopeKey = 'github.com';

  constructor(
    private readonly client: GitHubCatalogPageClient,
    private readonly perPage = 100,
  ) {}

  async listProjects(): Promise<CatalogPageResult<ProviderProjectRef>> {
    const projects = await collectPages(page => this.client.listProjectsPage(page, this.perPage), this.perPage);
    return mapPageResult(projects, project => ({
      platform: this.platform,
      projectKey: project.fullName,
      providerProjectId: String(project.id),
      name: project.name,
      defaultBranch: project.defaultBranch,
      webUrl: project.webUrl,
    }));
  }

  async listIssues(project: ProviderProjectRef): Promise<CatalogPageResult<ProviderIssue>> {
    const issues = await collectPages(
      page => this.client.listIssuesPage(project.projectKey, page, this.perPage),
      this.perPage,
    );
    return mapPageResult(issues, issue => issue.pullRequest ? null : ({
      issueNumber: issue.number,
      title: issue.title,
      description: issue.body ?? undefined,
      labels: issue.labels,
      state: issue.state === 'open' ? 'opened' : 'closed',
      webUrl: issue.webUrl,
    }));
  }
}

export interface GitLabCatalogProject {
  id: number;
  pathWithNamespace: string;
  name: string;
  defaultBranch?: string;
  webUrl?: string;
}

export interface GitLabCatalogIssue {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  state: 'opened' | 'closed';
  webUrl?: string;
}

export interface GitLabCatalogPageClient {
  listProjectsPage(page: number, perPage: number): Promise<GitLabCatalogProject[]>;
  listIssuesPage(projectId: string, page: number, perPage: number): Promise<GitLabCatalogIssue[]>;
}

export class GitLabProviderCatalog implements ProviderCatalog {
  readonly platform = 'gitlab' as const;
  readonly scopeKey: string;

  constructor(
    host: string,
    private readonly client: GitLabCatalogPageClient,
    private readonly perPage = 100,
  ) {
    this.scopeKey = normalizeHost(host);
  }

  async listProjects(): Promise<CatalogPageResult<ProviderProjectRef>> {
    const projects = await collectPages(page => this.client.listProjectsPage(page, this.perPage), this.perPage);
    return mapPageResult(projects, project => ({
      platform: this.platform,
      projectKey: `${this.scopeKey}/${project.pathWithNamespace}`,
      providerProjectId: String(project.id),
      name: project.name,
      defaultBranch: project.defaultBranch,
      webUrl: project.webUrl,
    }));
  }

  async listIssues(project: ProviderProjectRef): Promise<CatalogPageResult<ProviderIssue>> {
    const projectId = project.providerProjectId ?? project.projectKey.slice(this.scopeKey.length + 1);
    const issues = await collectPages(
      page => this.client.listIssuesPage(projectId, page, this.perPage),
      this.perPage,
    );
    return mapPageResult(issues, issue => ({
      issueNumber: issue.iid,
      title: issue.title,
      description: issue.description ?? undefined,
      labels: issue.labels,
      state: issue.state,
      webUrl: issue.webUrl,
    }));
  }
}

async function collectPages<T>(
  loadPage: (page: number) => Promise<T[]>,
  perPage: number,
): Promise<CatalogPageResult<T>> {
  const all: T[] = [];
  for (let page = 1; ; page += 1) {
    try {
      const current = await loadPage(page);
      all.push(...current);
      if (current.length < perPage) return all;
    } catch (error) {
      return { items: all, error };
    }
  }
}

function mapPageResult<T, R>(result: CatalogPageResult<T>, map: (item: T) => R | null): CatalogPageResult<R> {
  const items = (Array.isArray(result) ? result : result.items)
    .flatMap(item => {
      const mapped = map(item);
      return mapped === null ? [] : [mapped];
    });
  return Array.isArray(result) ? items : { items, error: result.error };
}

function normalizeHost(host: string): string {
  const withProtocol = host.includes('://') ? host : `https://${host}`;
  return new URL(withProtocol).host;
}
