import { execFileSync } from 'node:child_process';
import { Octokit } from '@octokit/rest';
import { GitHubClient } from '../github/client.js';
import { GitLabClient } from '../gitlab/index.js';
import {
  resolveGitHubRepository,
  resolveGitLabProject,
} from '../tracker/resolver.js';
import {
  resolveTrackerTarget,
  type TrackerPlatform,
  type TrackerTargetCredentials,
} from '../tracker/target.js';
import { getGlabToken, listGlabTokens, type GlabTokenConfig } from '../gitlab/glab-config.js';
import type { TrackerProvider } from '../../domain/tracker/types.js';
import { createManagementProviderBundle, createProviderBundle } from './providers.js';
import type { ManagementProviderBundle, ProviderBundle, ProviderBundleOptions } from './providers.js';
import {
  GitHubProviderCatalog,
  GitLabProviderCatalog,
  type GitHubCatalogIssue,
  type GitHubCatalogProject,
} from './catalogs.js';
import type { ProviderAccountIdentity, ProviderCatalog } from '../../domain/work-item/provider-types.js';
import { normalizeGitLabHost } from '../../shared/gitlab-project.js';

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
    return { url: gitLabUrl(envUrl), token: envToken };
  }

  const glab = getGlabToken(requestedHost);
  if (!glab || (requestedHost && normalizeGitLabHost(glab.host) !== requestedHost)) {
    throw new Error(`GitLab authentication requires a matching glab token for host ${requestedHost ?? 'default'}`);
  }

  const url = gitLabUrl(glab.apiHost);
  return { url, token: glab.token };
}

function gitLabUrl(preferredHost?: string): string {
  const host = preferredHost ?? 'gitlab.com';
  return /^https?:\/\//i.test(host) ? host : `https://${host}`;
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

export type { TrackerPlatform } from '../tracker/target.js';
export type { ManagementProviderBundle } from './providers.js';
export type GlobalTrackerPlatform = TrackerPlatform | 'all';

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

export async function resolveProviderAccountIdentities(catalogs: readonly ProviderCatalog[]): Promise<ProviderAccountIdentity[]> {
  const identities = await Promise.all(catalogs.map(async catalog => {
    if (!catalog.getAccountIdentity) throw new Error(`Verified ${catalog.platform} account identity is unavailable for ${catalog.scopeKey}`);
    return catalog.getAccountIdentity();
  }));
  return identities;
}

/**
 * Report which providers are configured. Only consulted when the platform has
 * to be inferred from a project key, so the `gh` lookup stays off the hot
 * path of git-backed commands.
 */
function detectTrackerCredentials(env: NodeJS.ProcessEnv = process.env): TrackerTargetCredentials {
  return {
    github: Boolean(env.GITHUB_TOKEN ?? env.GH_TOKEN ?? readGhToken()),
    gitlab: Boolean(env.GITLAB_TOKEN) || listGlabTokens().length > 0,
  };
}

/**
 * Create the tracker client for one command invocation.
 *
 * The target platform and project are resolved from the explicit arguments,
 * the `AFK_TRACKER_*` environment variables, or the `origin` remote of the
 * working directory — in that order. A directory that is not a git
 * repository is therefore usable as soon as the target is configured.
 */
export async function createTracker(
  projectId?: string,
  cwd?: string,
  platform?: TrackerPlatform,
  preferredHost?: string,
): Promise<TrackerProvider> {
  const target = await resolveTrackerTarget({
    project: projectId,
    platform,
    cwd,
    credentials: () => detectTrackerCredentials(),
  });
  return target.platform === 'github'
    ? createGitHubTracker(target.projectId, cwd)
    : createGitLabTracker(target.projectId, cwd, preferredHost);
}

export async function createWorkflowProviders(
  projectId?: string,
  cwd = process.cwd(),
  options?: ProviderBundleOptions,
  platform?: TrackerPlatform,
  preferredHost?: string,
): Promise<ProviderBundle> {
  const tracker = await createTracker(projectId, cwd, platform, preferredHost);
  return createProviderBundle(tracker, cwd, options);
}

export async function createManagementProviders(
  projectId?: string,
  cwd = process.cwd(),
  platform?: TrackerPlatform,
  preferredHost?: string,
): Promise<ManagementProviderBundle> {
  const tracker = await createTracker(projectId, cwd, platform, preferredHost);
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
    ...(env.GITLAB_TOKEN ? [{ host: new URL(normalizeProviderUrl(env.GITLAB_URL ?? 'https://gitlab.com')).host,
      url: env.GITLAB_URL ?? 'https://gitlab.com', token: env.GITLAB_TOKEN }] : []),
    ...glabTokens.map(entry => ({
      host: new URL(normalizeProviderUrl(entry.host)).host,
      url: `${entry.apiProtocol}://${entry.apiHost}`,
      token: entry.token,
    })),
  ];
  const unique = new Map<string, { host: string; url: string; token: string }>();
  for (const entry of configured) {
    const url = normalizeProviderUrl(entry.url);
    if (!unique.has(entry.host)) unique.set(entry.host, { host: entry.host, url, token: entry.token });
  }
  return [...unique.values()].sort((left, right) => left.host.localeCompare(right.host));
}

function createGitHubProviderCatalog(token: string): ProviderCatalog {
  const client = new Octokit({ auth: token, userAgent: 'afk v1' });
  const catalog = new GitHubProviderCatalog({
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
        updatedAt: issue.updated_at,
        pullRequest: 'pull_request' in issue,
      }));
    },
  });
  return Object.assign(catalog, {
    getAccountIdentity: async (): Promise<ProviderAccountIdentity> => {
      const response = await client.users.getAuthenticated();
      return { platform: 'github', host: 'github.com', accountId: String(response.data.id) };
    },
  });
}

function createGitLabProviderCatalog(host: string, url: string, token: string): ProviderCatalog {
  const baseUrl = normalizeProviderUrl(url);
  const catalog = new GitLabProviderCatalog(host, {
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
      updatedAt: issue.updated_at,
    }))),
  });
  return Object.assign(catalog, {
    getAccountIdentity: async (): Promise<ProviderAccountIdentity> => {
      const user = await fetchGitLabObject<GitLabUserResponse>(baseUrl, token, '/api/v4/user', {});
      if (!user || user.id === undefined) throw new Error(`GitLab account identity is unavailable for ${host}`);
      return { platform: 'gitlab', host, accountId: String(user.id) };
    },
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
  updated_at?: string;
}

interface GitLabUserResponse {
  id: number;
}

async function fetchGitLabPage<T>(
  baseUrl: string,
  token: string,
  pathname: string,
  query: Record<string, string>,
): Promise<T[]> {
  const target = new URL(pathname, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  const response = await fetch(target, { headers: { 'PRIVATE-TOKEN': token } });
  if (!response.ok) throw new Error(`GitLab API HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<T[]>;
}

async function fetchGitLabObject<T>(
  baseUrl: string,
  token: string,
  pathname: string,
  query: Record<string, string>,
): Promise<T> {
  const target = new URL(pathname, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) target.searchParams.set(key, value);
  const response = await fetch(target, { headers: { 'PRIVATE-TOKEN': token } });
  if (!response.ok) throw new Error(`GitLab API HTTP ${response.status}: ${response.statusText}`);
  return response.json() as Promise<T>;
}

function normalizeProviderUrl(value: string): string {
  const url = new URL(value.includes('://') ? value : `https://${value}`);
  return url.origin;
}
