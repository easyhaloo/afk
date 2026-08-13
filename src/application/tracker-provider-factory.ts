import { execFileSync } from 'node:child_process';
import { GitHubClient } from '../infrastructure/github/client';
import { GitLabClient } from '../infrastructure/gitlab';
import { detectGitHubRepo, detectGitLabProject, detectProject } from '../domain/tracker/detect';
import { getGlabToken } from '../infrastructure/gitlab/glab-config';
import type { TrackerProvider } from '../domain/tracker/types';
import {
  createManagementProviderBundle,
  createProviderBundle,
} from './providers';
import type {
  ManagementProviderBundle,
  ProviderBundle,
  ProviderBundleOptions,
} from './providers';

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
  if (envToken) {
    return { url: envUrl ?? 'https://gitlab.com', token: envToken };
  }

  const glab = getGlabToken(preferredHost);
  if (!glab) {
    throw new Error('GitLab authentication is required. Set GITLAB_TOKEN or authenticate with glab auth login.');
  }

  const url = glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`;
  return { url, token: glab.token };
}

export async function createGitHubTracker(repo?: string, cwd?: string): Promise<GitHubClient> {
  const project = repo ?? process.env.GITHUB_REPOSITORY ?? await detectGitHubRepo(cwd);
  if (!project) {
    throw new Error('Could not determine GitHub repository. Pass owner/repo or run inside a GitHub repository.');
  }
  return new GitHubClient({ repo: project, auth: resolveGitHubToken() });
}

export async function createGitLabTracker(projectId?: string, cwd?: string): Promise<GitLabClient> {
  const project = projectId ?? await detectGitLabProject(cwd);
  if (!project) {
    throw new Error('Could not determine GitLab project. Pass the project path or run inside a GitLab repository.');
  }
  const auth = resolveGitLabAuth(process.env.GITLAB_URL);
  return new GitLabClient({ url: auth.url, token: auth.token, projectId: project });
}

export async function createTracker(projectId?: string, cwd?: string): Promise<TrackerProvider> {
  const detected = await detectProject(cwd);
  return detected.platform === 'github'
    ? createGitHubTracker(projectId, cwd)
    : createGitLabTracker(projectId, cwd);
}

export async function createWorkflowProviders(
  projectId?: string,
  cwd = process.cwd(),
  options?: ProviderBundleOptions,
): Promise<ProviderBundle> {
  const tracker = await createTracker(projectId, cwd);
  return createProviderBundle(tracker, cwd, options);
}

export async function createManagementProviders(
  projectId?: string,
  cwd = process.cwd(),
): Promise<ManagementProviderBundle> {
  const tracker = await createTracker(projectId, cwd);
  return createManagementProviderBundle(tracker, cwd);
}
