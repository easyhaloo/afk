import { GitLabClient } from './core/gitlab/index';
import { GitHubClient } from './core/github/client';
import { detectGitLabProject, detectProject } from './core/tracker/detect';
import { detectGitHubRepo } from './core/tracker/detect';
import { getGlabToken } from './core/gitlab/glab-config';
import type { TrackerProvider } from './core/tracker/types';

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
 */
async function resolveGitLabConfig(): Promise<GitLabConfig> {
  const envUrl = process.env.GITLAB_URL;
  let token = process.env.GITLAB_TOKEN;
  let projectId = process.env.GITLAB_PROJECT_ID;
  let url = envUrl || 'https://gitlab.com';

  // Try glab CLI config if no env token
  if (!token) {
    const glab = getGlabToken(envUrl);
    if (glab) {
      url = glab.apiHost.startsWith('http') ? glab.apiHost : `https://${glab.apiHost}`;
      token = glab.token;
    }
  }

  if (!token) {
    throw new Error('GITLAB_TOKEN environment variable is required (or authenticate glab: glab auth login)');
  }

  // Try git remote detection if no env project ID
  if (!projectId) {
    const detected = await detectGitLabProject();
    if (detected) projectId = detected;
  }

  if (!projectId) {
    throw new Error('GITLAB_PROJECT_ID environment variable is required (or run from a git project with a remote)');
  }

  return { url, token, projectId };
}

/**
 * Create GitLab client with automatic token and project detection
 *
 * Detection order:
 * 1. Environment variables (GITLAB_TOKEN, GITLAB_PROJECT_ID, GITLAB_URL)
 * 2. glab CLI authentication (read from config.yml)
 * 3. Git remote detection for project ID
 */
export async function createGitLabClient(): Promise<GitLabClient> {
  const { url, token, projectId } = await resolveGitLabConfig();
  return new GitLabClient({ url, token, projectId });
}

/**
 * Create GitHub client with token and repo detection.
 *
 * Token must come from GITHUB_TOKEN or GH_TOKEN env var. We deliberately
 * do NOT shell out to `gh auth token` — that's CLI parsing across gh
 * versions. Users authenticated via `gh auth login` should run
 * `gh auth token` once and `export GITHUB_TOKEN=...`.
 */
export async function createGitHubClient(): Promise<GitHubClient> {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN (or GH_TOKEN) environment variable is required.\n' +
      'If you authenticated via `gh auth login`, run: gh auth token | read TOK && export GITHUB_TOKEN=$TOK'
    );
  }

  let repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    const detected = await detectGitHubRepo();
    if (!detected) {
      throw new Error('Could not detect GitHub repository. Set GITHUB_REPOSITORY=owner/repo or run from a GitHub repository.');
    }
    repo = detected;
  }

  return new GitHubClient({ repo, auth: token });
}

/**
 * Create tracker client with automatic platform detection
 *
 * Detects platform from git remote and returns appropriate client.
 * This is the unified entry point for platform-agnostic commands.
 */
export async function createTrackerClient(): Promise<TrackerProvider> {
  const { platform } = await detectProject();

  if (platform === 'github') {
    return await createGitHubClient();
  } else {
    // For GitLab, use the index version which implements TrackerProvider
    const { GitLabClient: TrackerGitLabClient } = await import('./core/gitlab/index');
    const { url, token, projectId } = await resolveGitLabConfig();
    return new TrackerGitLabClient({ url, token, projectId });
  }
}
