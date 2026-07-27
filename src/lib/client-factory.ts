import { GitLabClient } from './core/gitlab/index';
import { GitHubClient } from './core/github/client';
import { detectGitLabProject, detectProject } from './core/tracker/detect';
import { detectGitHubRepo } from './core/tracker/detect';
import { getGlabToken } from './core/gitlab/glab-config';
import { execSync } from 'child_process';
import type { TrackerProvider } from './core/tracker/types';

/**
 * Create GitLab client with automatic token and project detection
 *
 * Detection order:
 * 1. Environment variables (GITLAB_TOKEN, GITLAB_PROJECT_ID, GITLAB_URL)
 * 2. glab CLI authentication
 * 3. Git remote detection for project ID
 */
export async function createGitLabClient(): Promise<GitLabClient> {
  const envUrl = process.env.GITLAB_URL;
  let token = process.env.GITLAB_TOKEN;
  let projectId = process.env.GITLAB_PROJECT_ID;
  let url = envUrl || 'https://gitlab.com';

  // Try glab CLI if no env token
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

  return new GitLabClient({ url, token, projectId });
}

/**
 * Create GitHub client with automatic token and repo detection
 *
 * Detection order:
 * 1. Environment variables (GITHUB_TOKEN/GH_TOKEN, GITHUB_REPOSITORY)
 * 2. gh CLI authentication
 * 3. Git remote detection for repository
 */
export async function createGitHubClient(): Promise<GitHubClient> {
  // Get token from env or gh CLI
  let token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!token) {
    try {
      const raw = execSync('gh auth token', {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
      // gh v2.40+ may prefix with "github.com token:" — extract token portion.
      const match = raw.match(/(?:token:\s*)?(\S+)/);
      token = match ? match[1] : raw;
    } catch {
      throw new Error('GITHUB_TOKEN or GH_TOKEN environment variable is required (or authenticate gh: gh auth login)');
    }
  }

  // Get repo from env or git remote
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

    const envUrl = process.env.GITLAB_URL;
    let token = process.env.GITLAB_TOKEN;
    let projectId = process.env.GITLAB_PROJECT_ID;
    let url = envUrl || 'https://gitlab.com';

    // Try glab CLI if no env token
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

    return new TrackerGitLabClient({ url, token, projectId });
  }
}
