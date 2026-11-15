import type { ProviderProjectRef } from '../../domain/work-item/types.js';
import { canonicalProjectKey } from '../../domain/work-item/identity.js';
import type { CatalogPageResult, ProviderAccountIdentity, ProviderCatalog, ProviderIssue } from '../../domain/work-item/provider-types.js';

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
  updatedAt?: string;
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
      updatedAt: issue.updatedAt,
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
  updatedAt?: string;
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
      projectKey: canonicalProjectKey(this.platform, project.pathWithNamespace, this.scopeKey),
      providerHost: this.scopeKey,
      providerProjectId: String(project.id),
      name: project.name,
      defaultBranch: project.defaultBranch,
      webUrl: project.webUrl,
    }));
  }

  async listIssues(project: ProviderProjectRef): Promise<CatalogPageResult<ProviderIssue>> {
    const projectPrefix = project.providerHost ? `${project.providerHost}/` : '';
    const projectId = project.providerProjectId ?? (projectPrefix && project.projectKey.startsWith(projectPrefix)
      ? project.projectKey.slice(projectPrefix.length)
      : project.projectKey);
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
      updatedAt: issue.updatedAt,
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

/**
 * What the geelib catalog needs from the HTTP client. `GeelibClient`
 * satisfies this structurally; tests inject a fake.
 */
export interface GeelibCatalogClient {
  listCatalogProjects(): Promise<Array<{ id: number; name: string; updatedAt?: string }>>;
  listCatalogIssues(subId: number): Promise<Array<{
    issueNumber: number;
    title: string;
    description: string;
    labels: string[];
    state: 'opened' | 'closed';
    updatedAt?: string;
    webUrl: string;
  }>>;
  accountIdentity(): Promise<{ accountId: string }>;
}

/**
 * The geelib entry of the global work-item inventory.
 *
 * A geelib project is named by its numeric id, so the canonical project key
 * and the provider project id are the same string; the instance host lives
 * in the scope key and keeps two deployments apart.
 */
export class GeelibProviderCatalog implements ProviderCatalog {
  readonly platform = 'geelib' as const;
  readonly scopeKey: string;

  constructor(
    private readonly client: GeelibCatalogClient,
    host: string,
  ) {
    this.scopeKey = normalizeHost(host);
  }

  async listProjects(): Promise<CatalogPageResult<ProviderProjectRef>> {
    const projects = await this.client.listCatalogProjects();
    return projects.map(project => ({
      platform: this.platform,
      projectKey: canonicalProjectKey(this.platform, String(project.id)),
      providerProjectId: String(project.id),
      name: project.name,
    }));
  }

  async listIssues(project: ProviderProjectRef): Promise<CatalogPageResult<ProviderIssue>> {
    const subId = Number(project.providerProjectId ?? project.projectKey);
    if (!Number.isSafeInteger(subId) || subId <= 0) throw new Error(`Invalid geelib project: ${project.projectKey}`);
    const issues = await this.client.listCatalogIssues(subId);
    return issues.map(issue => ({
      issueNumber: issue.issueNumber,
      title: issue.title,
      description: issue.description || undefined,
      labels: issue.labels,
      state: issue.state,
      webUrl: issue.webUrl,
      updatedAt: issue.updatedAt,
    }));
  }

  readonly getAccountIdentity = async (): Promise<ProviderAccountIdentity> => {
    const { accountId } = await this.client.accountIdentity();
    return { platform: this.platform, host: this.scopeKey, accountId };
  };
}
