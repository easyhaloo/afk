import type { ProviderProjectRef } from '@afk/application';
import type {
  CatalogPageResult,
  ProviderCatalog,
  ProviderIssue,
  ScopedProviderIssue,
} from '@afk/application';

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

/** A GitHub issue plus the repository it belongs to, as returned by a scoped search. */
export interface GitHubScopedCatalogIssue extends GitHubCatalogIssue {
  projectKey: string;
}

export interface GitHubScopedPageResult {
  items: GitHubScopedCatalogIssue[];
  totalCount: number;
}

export interface GitHubCatalogPageClient {
  listProjectsPage(page: number, perPage: number): Promise<GitHubCatalogProject[]>;
  listIssuesPage(projectKey: string, page: number, perPage: number): Promise<GitHubCatalogIssue[]>;
  /**
   * Search every issue of one owner across their repositories. `totalCount`
   * is the platform-wide match count, which the caller uses to decide
   * whether the result set is still addressable in full.
   */
  listIssuesByOwnerPage(owner: string, page: number, perPage: number): Promise<GitHubScopedPageResult>;
}

/** GitHub's issue search refuses to page past this many matches. */
export const GITHUB_SEARCH_RESULT_LIMIT = 1000;

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

  /**
   * One search per repository owner replaces one issue request per
   * repository. The result is restricted to the projects that were passed in,
   * so the inventory covers exactly the same issues as the per-project path.
   */
  async listIssuesAcrossScope(projects: readonly ProviderProjectRef[]): Promise<CatalogPageResult<ScopedProviderIssue>> {
    const byProjectKey = new Map(projects.map(project => [project.projectKey, project]));
    const owners = [...new Set(projects.map(project => project.projectKey.split('/')[0]).filter(Boolean))];
    if (!owners.length) return [];

    const collected: GitHubScopedCatalogIssue[] = [];
    const perOwner = await Promise.all(owners.map(owner => this.collectOwnerIssues(owner)));
    for (const result of perOwner) {
      if (!Array.isArray(result)) return result;
      collected.push(...result);
    }

    const items = collected
      .filter(issue => !issue.pullRequest)
      .flatMap(issue => {
        const project = byProjectKey.get(issue.projectKey);
        if (!project) return [];
        return [{
          issue: {
            issueNumber: issue.number,
            title: issue.title,
            description: issue.body ?? undefined,
            labels: issue.labels,
            state: issue.state === 'open' ? 'opened' as const : 'closed' as const,
            webUrl: issue.webUrl,
          },
          project,
        }];
      });
    return items;
  }

  private async collectOwnerIssues(owner: string): Promise<GitHubScopedCatalogIssue[] | { items: ScopedProviderIssue[]; error: unknown }> {
    let first: GitHubScopedPageResult;
    try {
      first = await this.client.listIssuesByOwnerPage(owner, 1, this.perPage);
    } catch (error) {
      return { items: [], error };
    }
    if (first.totalCount > GITHUB_SEARCH_RESULT_LIMIT) {
      return { items: [], error: new Error(`github issue search for '${owner}' exceeds ${GITHUB_SEARCH_RESULT_LIMIT} matches`) };
    }
    // The match count is known after the first page, so the remaining pages
    // can be requested concurrently instead of one round trip each.
    const pageCount = Math.ceil(first.totalCount / this.perPage);
    if (pageCount <= 1) return first.items;
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_unused, index) => this.client.listIssuesByOwnerPage(owner, index + 2, this.perPage)),
    );
    return [first, ...rest].flatMap(page => page.items);
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

/** A GitLab issue plus the numeric project it belongs to. */
export interface GitLabScopedCatalogIssue extends GitLabCatalogIssue {
  projectId: string;
}

export interface GitLabCatalogPageClient {
  listProjectsPage(page: number, perPage: number): Promise<GitLabCatalogProject[]>;
  listIssuesPage(projectId: string, page: number, perPage: number): Promise<GitLabCatalogIssue[]>;
  /** GitLab's global issue feed: every issue the token can see, across projects. */
  listIssuesAcrossScopePage(page: number, perPage: number): Promise<GitLabScopedCatalogIssue[]>;
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
    }));
  }

  /**
   * GitLab's global issue feed replaces one issue request per project. The
   * feed is restricted to the projects that were passed in, so the inventory
   * covers exactly the same issues as the per-project path.
   */
  async listIssuesAcrossScope(projects: readonly ProviderProjectRef[]): Promise<CatalogPageResult<ScopedProviderIssue>> {
    const byProjectId = new Map(
      projects
        .filter(project => project.providerProjectId !== undefined)
        .map(project => [String(project.providerProjectId), project] as const),
    );
    if (!byProjectId.size) return [];

    const collected: GitLabScopedCatalogIssue[] = [];
    for (let page = 1; ; page += 1) {
      let current: GitLabScopedCatalogIssue[];
      try {
        current = await this.client.listIssuesAcrossScopePage(page, this.perPage);
      } catch (error) {
        return { items: [], error };
      }
      collected.push(...current);
      if (current.length < this.perPage) break;
    }

    return collected.flatMap(issue => {
      const project = byProjectId.get(issue.projectId);
      if (!project) return [];
      return [{
        issue: {
          issueNumber: issue.iid,
          title: issue.title,
          description: issue.description ?? undefined,
          labels: issue.labels,
          state: issue.state,
          webUrl: issue.webUrl,
        },
        project,
      }];
    });
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
