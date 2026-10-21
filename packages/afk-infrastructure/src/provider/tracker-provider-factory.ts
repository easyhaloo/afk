import { execFileSync } from 'node:child_process';
import { Octokit } from '@octokit/rest';
import { GitHubClient } from './github-client.js';
import { GitLabClient } from './gitlab-client.js';
import {
  resolveGitHubRepository,
  resolveGitLabProject,
  resolveTrackerProject,
} from './tracker-resolver.js';
import { getGlabToken, listGlabTokens, type GlabTokenConfig } from './glab-config.js';
import type { TrackerProvider } from '@afk/application';
import { createManagementProviderBundle, createProviderBundle } from './providers.js';
import type { ManagementProviderBundle, ProviderBundle, ProviderBundleOptions } from './providers.js';
import {
  GitHubProviderCatalog,
  GitLabProviderCatalog,
  type GitHubCatalogIssue,
  type GitHubCatalogProject,
  type GitHubScopedPageResult,
} from './catalogs.js';
import type { ProviderCatalog } from '@afk/application';
import { gitLabApiUrl, gitLabBaseUrl, normalizeGitLabHost } from '../shared/gitlab-project.js';

function readGhToken(): string | null {
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5_000 }).trim();
    return token || null;
  } catch {
    return null;
  }
}

function resolveGitHubToken(): string {
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? readGhToken();
  if (!token) {
    throw new Error('GitHub authentication is required. Set GITHUB_TOKEN/GH_TOKEN or authenticate with gh auth login.');
  }
  return token;
}

function resolveGitLabAuth(preferredHost?: string): { url: string; token: string } {
  const envUrl = process.env.GITLAB_URL;
  const envToken = process.env.GITLAB_TOKEN;
  const requestedHost = preferredHost || envUrl ? normalizeGitLabHost(preferredHost ?? envUrl) : undefined;
  if (envToken) {
    const envHost = normalizeGitLabHost(envUrl);
    if (requestedHost && requestedHost !== envHost) {
      throw new Error(`GITLAB_TOKEN host ${envHost} does not match requested GitLab host ${requestedHost}`);
    }
    return { url: gitLabBaseUrl(envUrl), token: envToken };
  }

  const glab = getGlabToken(requestedHost);
  if (!glab || (requestedHost && normalizeGitLabHost(glab.host) !== requestedHost)) {
    throw new Error(`GitLab authentication requires a matching glab token for host ${requestedHost ?? 'default'}`);
  }

  const url = gitLabBaseUrl(glab.apiHost);
  return { url, token: glab.token };
}

export async function createGitHubTracker(repo?: string, cwd?: string): Promise<GitHubClient> {
  const project = repo ?? process.env.GITHUB_REPOSITORY ?? await resolveGitHubRepository(cwd);
  if (!project) {
    throw new Error('Could not determine GitHub repository. Pass owner/repo or run inside a GitHub repository.');
  }
  return new GitHubClient({ repo: project, auth: resolveGitHubToken() });
}

export async function createGitLabTracker(projectId?: string, cwd?: string, preferredHost?: string): Promise<GitLabClient> {
  const project = projectId ?? await resolveGitLabProject(cwd);
  if (!project) {
    throw new Error('Could not determine GitLab project. Pass the project path or run inside a GitLab repository.');
  }
  const auth = resolveGitLabAuth(preferredHost);
  return new GitLabClient({ url: auth.url, token: auth.token, projectId: project });
}

/**
 * The platforms a tracker can live on. The list belongs here because this is
 * where the catalogs are built: a caller that validates a platform reads it
 * rather than keeping a copy of its own.
 */
export const TRACKER_PLATFORMS = ['github', 'gitlab'] as const;
export type TrackerPlatform = (typeof TRACKER_PLATFORMS)[number];

/** The platforms a global inventory can be collected from, plus the aggregate. */
export const GLOBAL_TRACKER_PLATFORMS = [...TRACKER_PLATFORMS, 'all'] as const;
export type GlobalTrackerPlatform = (typeof GLOBAL_TRACKER_PLATFORMS)[number];

export interface GlobalWorkItemCatalogDependencies {
  env: Record<string, string | undefined>;
  readGhToken(): string | null;
  listGlabTokens(): GlabTokenConfig[];
  createGitHubCatalog(token: string): ProviderCatalog;
  createGitLabCatalog(host: string, url: string, token: string): ProviderCatalog;
}

export function createGlobalWorkItemCatalogs(
  platform: GlobalTrackerPlatform = 'all',
  dependencies: GlobalWorkItemCatalogDependencies = defaultCatalogDependencies(),
): ProviderCatalog[] {
  const catalogs: ProviderCatalog[] = [];
  if (platform === 'all' || platform === 'github') {
    const token = dependencies.env.GITHUB_TOKEN ?? dependencies.env.GH_TOKEN ?? dependencies.readGhToken();
    if (token) catalogs.push(dependencies.createGitHubCatalog(token));
    else if (platform === 'github') throw new Error('GitHub authentication is required. Set GITHUB_TOKEN/GH_TOKEN or authenticate with gh auth login.');
  }
  if (platform === 'all' || platform === 'gitlab') {
    const configured = configuredGitLabTokens(dependencies.env, dependencies.listGlabTokens());
    catalogs.push(...configured.map(entry => dependencies.createGitLabCatalog(entry.host, entry.url, entry.token)));
    if (configured.length === 0 && platform === 'gitlab') {
      throw new Error('GitLab authentication is required. Set GITLAB_TOKEN or authenticate with glab auth login.');
    }
  }
  if (catalogs.length === 0) {
    throw new Error('Provider authentication is required. Configure GitHub or GitLab credentials.');
  }
  return catalogs;
}

function asTrackerPlatform(value: unknown): TrackerPlatform | undefined {
  return value === 'github' || value === 'gitlab' ? value : undefined;
}

export async function createTracker(
  projectId?: string,
  cwd?: string,
  platform?: TrackerPlatform,
  preferredHost?: string,
): Promise<TrackerProvider> {
  const override = asTrackerPlatform(platform);
  if (override === 'github') return createGitHubTracker(projectId, cwd);
  if (override === 'gitlab') return createGitLabTracker(projectId, cwd, preferredHost);
  const detected = await resolveTrackerProject(cwd);
  return detected.platform === 'github'
    ? createGitHubTracker(projectId, cwd)
    : createGitLabTracker(projectId, cwd, preferredHost);
}

export async function createWorkflowProviders(
  projectId?: string,
  cwd = process.cwd(),
  options?: ProviderBundleOptions,
  platform?: TrackerPlatform,
): Promise<ProviderBundle> {
  const tracker = await createTracker(projectId, cwd, platform);
  return createProviderBundle(tracker, cwd, options);
}

export async function createManagementProviders(
  projectId?: string,
  cwd = process.cwd(),
  platform?: TrackerPlatform,
): Promise<ManagementProviderBundle> {
  const tracker = await createTracker(projectId, cwd, platform);
  return createManagementProviderBundle(tracker, cwd);
}

function defaultCatalogDependencies(): GlobalWorkItemCatalogDependencies {
  return {
    env: process.env,
    readGhToken,
    listGlabTokens,
    createGitHubCatalog: createGitHubProviderCatalog,
    createGitLabCatalog: createGitLabProviderCatalog,
  };
}

function configuredGitLabTokens(
  env: Record<string, string | undefined>,
  glabTokens: GlabTokenConfig[],
): Array<{ host: string; url: string; token: string }> {
  const configured = [
    ...(env.GITLAB_TOKEN ? [{ host: normalizeGitLabHost(gitLabBaseUrl(env.GITLAB_URL)),
      url: gitLabBaseUrl(env.GITLAB_URL), token: env.GITLAB_TOKEN }] : []),
    ...glabTokens.map(entry => ({
      host: normalizeGitLabHost(entry.host),
      url: gitLabBaseUrl(`${entry.apiProtocol}://${entry.apiHost}`),
      token: entry.token,
    })),
  ];
  const unique = new Map<string, { host: string; url: string; token: string }>();
  for (const entry of configured) {
    const url = gitLabBaseUrl(entry.url);
    if (!unique.has(entry.host)) unique.set(entry.host, { host: entry.host, url, token: entry.token });
  }
  return [...unique.values()].sort((left, right) => left.host.localeCompare(right.host));
}

function createGitHubProviderCatalog(token: string): ProviderCatalog {
  const client = new Octokit({ auth: token, userAgent: 'afk v1' });
  return new GitHubProviderCatalog({
    async listProjectsPage(page, perPage): Promise<GitHubCatalogProject[]> {
      const response = await client.repos.listForAuthenticatedUser({
        affiliation: 'owner,collaborator,organization_member',
        visibility: 'all',
        sort: 'full_name',
        direction: 'asc',
        page,
        per_page: perPage,
      });
      return response.data.map(project => ({
        id: project.id,
        fullName: project.full_name,
        name: project.name,
        defaultBranch: project.default_branch,
        webUrl: project.html_url,
      }));
    },
    async listIssuesPage(projectKey, page, perPage): Promise<GitHubCatalogIssue[]> {
      const [owner, repo] = projectKey.split('/');
      if (!owner || !repo) throw new Error(`Invalid GitHub repository: ${projectKey}`);
      const response = await client.issues.listForRepo({ owner, repo, state: 'all', page, per_page: perPage });
      return response.data.map(issue => ({
        number: issue.number,
        title: issue.title,
        body: issue.body ?? null,
        labels: issue.labels.map(label => typeof label === 'string' ? label : label.name ?? ''),
        state: issue.state === 'closed' ? 'closed' : 'open',
        webUrl: issue.html_url,
        pullRequest: 'pull_request' in issue,
      }));
    },
    async listIssuesByOwnerPage(owner, page, perPage): Promise<GitHubScopedPageResult> {
      // `is:issue` keeps pull requests out, matching the per-repository
      // issue listing, and `user:` covers both users and organisations.
      const response = await client.search.issuesAndPullRequests({
        q: `is:issue user:${owner}`,
        sort: 'created',
        order: 'asc',
        page,
        per_page: perPage,
      });
      return {
        totalCount: response.data.total_count,
        items: response.data.items.map(issue => ({
          number: issue.number,
          title: issue.title,
          body: issue.body ?? null,
          labels: issue.labels.map(label => typeof label === 'string' ? label : label.name ?? ''),
          state: issue.state === 'closed' ? 'closed' : 'open',
          webUrl: issue.html_url,
          pullRequest: 'pull_request' in issue,
          projectKey: issue.repository_url.split('/repos/')[1] ?? '',
        })),
      };
    },
  });
}

function createGitLabProviderCatalog(host: string, url: string, token: string): ProviderCatalog {
  const baseUrl = gitLabBaseUrl(url);
  return new GitLabProviderCatalog(host, {
    listProjectsPage: (page, perPage) => fetchGitLabPage<GitLabProjectResponse>(
      baseUrl,
      token,
      '/api/v4/projects',
      { membership: 'true', simple: 'true', order_by: 'path', sort: 'asc', page: String(page), per_page: String(perPage) },
    ).then(projects => projects.map(project => ({
      id: project.id,
      pathWithNamespace: project.path_with_namespace,
      name: project.name,
      defaultBranch: project.default_branch ?? undefined,
      webUrl: project.web_url,
    }))),
    listIssuesPage: (projectId, page, perPage) => fetchGitLabPage<GitLabIssueResponse>(
      baseUrl,
      token,
      `/api/v4/projects/${encodeURIComponent(projectId)}/issues`,
      { scope: 'all', state: 'all', page: String(page), per_page: String(perPage) },
    ).then(issues => issues.map(issue => ({
      iid: issue.iid,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      state: issue.state,
      webUrl: issue.web_url,
    }))),
    listIssuesAcrossScopePage: (page, perPage) => fetchGitLabPage<GitLabIssueResponse>(
      baseUrl,
      token,
      '/api/v4/issues',
      { scope: 'all', state: 'all', page: String(page), per_page: String(perPage) },
    ).then(issues => issues.map(issue => ({
      iid: issue.iid,
      title: issue.title,
      description: issue.description,
      labels: issue.labels,
      state: issue.state,
      webUrl: issue.web_url,
      projectId: String(issue.project_id),
    }))),
  });
}

interface GitLabProjectResponse {
  id: number;
  path_with_namespace: string;
  name: string;
  default_branch: string | null;
  web_url: string;
}

interface GitLabIssueResponse {
  iid: number;
  title: string;
  description: string | null;
  labels: string[];
  state: 'opened' | 'closed';
  web_url: string;
  project_id: number;
}

async function fetchGitLabPage<T>(
  baseUrl: string,
  token: string,
  pathname: string,
  query: Record<string, string>,
): Promise<T[]> {
  const target = new URL(gitLabApiUrl(baseUrl, pathname));
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  const response = await fetch(target, { headers: { 'PRIVATE-TOKEN': token } });
  if (!response.ok) throw new Error(`GitLab API HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<T[]>;
}


