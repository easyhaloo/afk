import { detectPlatform, detectGitHubRepo, detectGitLabProject } from './detect.js';
import { GitHubClient } from '../github/index.js';
import { GitLabClient } from '../gitlab/index.js';
import type { TrackerProvider, Platform } from './types.js';

export type { TrackerProvider, Platform };
export type {
  TrackedIssue,
  TrackedMR,
  ListOptions,
  CreateIssueOptions,
  UpdateIssueOptions,
  ListMROptions,
  AcceptanceCriteria,
  LinkType,
} from './types.js';

export { detectPlatform, detectGitHubRepo, detectGitLabProject, detectProject } from './detect.js';

/**
 * Tracker config
 */
export interface TrackerConfig {
  /** Explicit platform override (auto-detected if omitted) */
  platform?: Platform;
  /** Explicit project ID (auto-detected if omitted) */
  projectId?: string;
  /** Working directory for git remote detection */
  cwd?: string;
}

/**
 * Create a TrackerProvider instance based on environment/remote detection
 */
export async function createTracker(config?: TrackerConfig): Promise<TrackerProvider> {
  const platform = config?.platform ?? await detectPlatform(config?.cwd);

  if (platform === 'github') {
    const repo = config?.projectId ?? await detectGitHubRepo(config?.cwd);
    if (!repo) throw new Error('Could not detect GitHub repo. Set GITHUB_REPO or run in a git repo with GitHub remote.');
    return new GitHubClient({ repo });
  } else {
    const projectId = config?.projectId ?? await detectGitLabProject(config?.cwd);
    if (!projectId) throw new Error('Could not detect GitLab project. Set GITLAB_PROJECT_ID or run in a git repo with GitLab remote.');
    // Use existing GitLab client with default config
    const url = process.env.GITLAB_URL || 'https://gitlab.com';
    const token = process.env.GITLAB_TOKEN;
    if (!token) throw new Error('GITLAB_TOKEN environment variable is required');
    return new GitLabClient({ url, token, projectId });
  }
}
