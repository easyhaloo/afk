import type { TrackerProvider } from '../../domain/tracker/types.js';
import type { BacklogProvider, QABacklogProvider } from '../../domain/backlog/index.js';
import type { BacklogGraphSource } from '../../domain/backlog/graph.js';
import { GitHubBacklogProvider } from '../../domain/backlog/github-provider.js';
import { GitLabBacklogProvider } from '../../domain/backlog/gitlab-provider.js';
import { ManagementBacklogProvider } from '../../domain/backlog/management-provider.js';
import type { AtomicClaim, ClaimLock, ClaimLockFactory } from '../../domain/backlog/claim-strategy.js';
import type { BranchProvider } from '../git/branches/provider.js';
import { GitBranchProvider } from '../git/branches/git-provider.js';
import type { ChangeProvider } from '../tracker/changes/provider.js';
import { TrackerChangeProvider } from '../tracker/changes/tracker-change-provider.js';
import { RecordingBacklogProvider } from '../tracker/recording-provider.js';

export interface ProviderBundle {
  backlog: BacklogProvider;
  branches: BranchProvider;
  changes: ChangeProvider;
}

export interface ManagementProviderBundle {
  backlog: QABacklogProvider;
  branches: BranchProvider;
  changes: ChangeProvider;
}

export interface ProviderBundleOptions {
  atomicClaim?: AtomicClaim;
  claimLock?: ClaimLock;
  claimLockFactory?: ClaimLockFactory;
  claimTtlMs?: number;
  /** Directory that holds the local tracker index. Defaults to the workspace. */
  trackerDirectory?: string;
  /**
   * Cross-project backlog relationships.
   *
   * A child backlog may live in another repository than its parent, so the
   * provider needs the whole backlog graph to decide whether an item still
   * has children.
   */
  graph?: BacklogGraphSource;
  /** Reports that the cross-project graph could not be read. */
  onGraphError?: (error: unknown) => void;
  /** The canonical project key of the project the tracker reads. */
  projectKey?: string;
}

export function createProviderBundle(
  tracker: TrackerProvider,
  repoRoot: string,
  options: ProviderBundleOptions = {},
): ProviderBundle {
  const backlog = tracker.platform === 'github'
    ? new GitHubBacklogProvider(tracker, options)
    : new GitLabBacklogProvider(tracker, options);
  return {
    // The recorder keeps the local tracker index in step with everything AFK
    // reads and writes, so later commands can resolve an issue id or a
    // directory to its provider project on their own.
    backlog: new RecordingBacklogProvider(backlog, {
      platform: tracker.platform,
      project: String(tracker.projectId),
      host: tracker.providerHost,
    }, repoRoot, options.trackerDirectory),
    branches: new GitBranchProvider(repoRoot),
    changes: new TrackerChangeProvider(tracker),
  };
}

export function createManagementProviderBundle(
  tracker: TrackerProvider,
  repoRoot: string,
): ManagementProviderBundle {
  return {
    backlog: new ManagementBacklogProvider(createProviderBundle(tracker, repoRoot).backlog),
    branches: new GitBranchProvider(repoRoot),
    changes: new TrackerChangeProvider(tracker),
  };
}
