import { detectPlatform, detectGitHubRepo, detectGitLabProject } from './detect';
import { GitHubClient } from '../github/index';
import { GitLabClient } from '../gitlab/index';
import type { TrackerProvider, Platform } from './types';

export type { TrackerProvider, Platform };
export type {
  TrackedIssue,
  TrackedMR,
  ListOptions,
  CreateIssueOptions,
  UpdateIssueOptions,
  LabelDelta,
  ListMROptions,
  AcceptanceCriteria,
  LinkType,
} from './types';

export { detectPlatform, detectGitHubRepo, detectGitLabProject, detectProject } from './detect';
export type { BacklogItem, BacklogProvider, BacklogState, BacklogExecutionMode, BacklogProviderCapabilities } from '../backlog';

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
    if (!projectId) throw new Error('Could not detect GitLab project. Pass --project or run in a git repo with GitLab remote.');
    // Use existing GitLab client with default config
    const url = process.env.GITLAB_URL || 'https://gitlab.com';
    const token = process.env.GITLAB_TOKEN;
    if (!token) throw new Error('GITLAB_TOKEN environment variable is required');
    return new GitLabClient({ url, token, projectId });
  }
}
