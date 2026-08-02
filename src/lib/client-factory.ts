import { execSync } from 'child_process';
import { GitLabClient } from './core/gitlab/index';
import { GitHubClient } from './core/github/client';
import { detectGitLabProject, detectProject } from './core/tracker/detect';
import { detectGitHubRepo } from './core/tracker/detect';
import { getGlabToken } from './core/gitlab/glab-config';
import type { TrackerProvider } from './core/tracker/types';

/**
 * Get GitHub token from gh CLI if available and authenticated
 */
function getGhToken(): string | null {
  try {
    const token = execSync('gh auth token', { encoding: 'utf8', timeout: 5000 }).trim();
    return token || null;
  } catch {
    return null;
  }
}

/**
 * Internal config resolved from env + glab CLI + git remote
 */
interface GitLabConfig {
  url: string;
  token: string;
  projectId: string;
}

/**
 * Resolve GitLab config from env, glab CLI, or git remote detection.
 *
 * projectId resolution order:
 *   1. Explicit `projectId` argument (from `--project <repo>` flag)
 *   2. Git remote detection (cwd's repo)
 */
async function resolveGitLabConfig(projectId?: string): Promise<GitLabConfig> {
  const envUrl = process.env.GITLAB_URL;
  let token = process.env.GITLAB_TOKEN;
  let resolvedProjectId = projectId;
  const url = envUrl || 'https://gitlab.com';

  // Try glab CLI config if no env token
  if (!token) {
    const glab = getGlabToken(envUrl);
    if (glab) {
      token = glab.token;
    }
  }

  if (!token) {
    throw new Error('GITLAB_TOKEN environment variable is required (or authenticate glab: glab auth login)');
  }

  // Detect project ID from git remote if no explicit arg was provided
  if (!resolvedProjectId) {
    const detected = await detectGitLabProject();
    if (!detected) {
      throw new Error(
        'Could not determine GitLab project. Pass --project <repo-path> ' +
        'or run from a git project with a GitLab remote.'
      );
    }
    resolvedProjectId = detected;
  }

  return { url, token, projectId: resolvedProjectId };
}

/**
 * Create GitLab client with automatic token and project detection.
 *
 * Detection order for project:
 *   1. Explicit `projectId` argument (from `--project <repo>` flag)
 *   2. Git remote detection (cwd's repo)
 */
export async function createGitLabClient(projectId?: string): Promise<GitLabClient> {
  const { url, token, projectId: resolvedProjectId } = await resolveGitLabConfig(projectId);
  return new GitLabClient({ url, token, projectId: resolvedProjectId });
}

/**
 * Create GitHub client with token and repo detection.
 *
 * Detection order for repo:
 *   1. Explicit `repo` argument (from `--project <repo>` flag)
 *   2. GITHUB_REPOSITORY env var
 *   3. Git remote detection (cwd's repo)
 */
export async function createGitHubClient(repo?: string): Promise<GitHubClient> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || getGhToken();
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN (or GH_TOKEN) environment variable is required.\n' +
      'Or authenticate with: gh auth login'
    );
  }

  let resolvedRepo = repo || process.env.GITHUB_REPOSITORY;
  if (!resolvedRepo) {
    const detected = await detectGitHubRepo();
    if (!detected) {
      throw new Error(
        'Could not detect GitHub repository. Pass --project owner/repo ' +
        'or set GITHUB_REPOSITORY=owner/repo or run from a GitHub repository.'
      );
    }
    resolvedRepo = detected;
  }

  return new GitHubClient({ repo: resolvedRepo, auth: token });
}

/**
 * Create tracker client with automatic platform detection.
 *
 * Detects platform from git remote and returns appropriate client.
 * This is the unified entry point for platform-agnostic commands.
 */
export async function createTrackerClient(projectId?: string): Promise<TrackerProvider> {
  const { platform } = await detectProject();

  if (platform === 'github') {
    return await createGitHubClient(projectId);
  } else {
    return await createGitLabClient(projectId);
  }
}