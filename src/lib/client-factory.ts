import { GitLabClient } from './core/gitlab/client';
import { GitHubClient } from './core/github/client';
import { detectGitLabProject } from './core/tracker/detect';
import { detectGitHubRepo } from './core/tracker/detect';
import { getGlabToken } from './core/gitlab/glab-config';
import { execSync } from 'child_process';

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
      token = execSync('gh auth token', { encoding: 'utf-8' }).trim();
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
