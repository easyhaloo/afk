import type { TrackerProvider } from '../../domain/tracker/types.js';
import type { BacklogProvider, QABacklogProvider } from '../../domain/backlog/index.js';
import type { BacklogGraphSource } from '../../domain/backlog/graph.js';
import { GitHubBacklogProvider } from '../../domain/backlog/github-provider.js';
import { GitLabBacklogProvider } from '../../domain/backlog/gitlab-provider.js';
import { ManagementBacklogProvider } from '../../domain/backlog/management-provider.js';
import type { AtomicClaim, ClaimLock, ClaimLockFactory } from '../../domain/backlog/claim-strategy.js';
import type { BranchProvider } from '../git/branches/provider.js';
import { GitBranchProvider } from '../git/branches/git-provider.js';
import type { ChangeProvider, CreateChangeInput, ChangeRequest } from '../tracker/changes/provider.js';
import { TrackerChangeProvider } from '../tracker/changes/tracker-change-provider.js';
import { RecordingBacklogProvider } from '../tracker/recording-provider.js';
import { GeelibBacklogProvider, type GeelibBacklogClient } from '../geelib/backlog-provider.js';

/**
 * The change channel of a geelib bundle.
 *
 * A geelib item's change request lives on the git platform the item's
 * repository is hosted on — the hybrid boundary this integration is built
 * on. This channel refuses, so a caller that reaches it learns which
 * assembly it needs rather than watching a git-shaped provider misread a
 * geelib tracker.
 */
class RefusingChangeProvider implements ChangeProvider {
  private refused(operation: string): () => Promise<never> {
    return async () => {
      throw new Error(`The geelib bundle carries no change channel: change requests live on the git platform (assemble the bundle with the repository's tracker for the change channel). Missing capability: ${operation}.`);
    };
  }

  create = this.refused('creating change requests');
  get = this.refused('reading change requests');
  findForBacklog = this.refused('finding the change request of a backlog item');
  verifyIssueAssociation = this.refused('verifying a change association');
  merge = this.refused('merging change requests');
  close = this.refused('closing change requests');
}

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
  /**
   * The change channel of a geelib bundle.
   *
   * Hybrid mode: a geelib item's change request lives on the git platform
   * that hosts the repository, not on geelib. Pass the tracker that platform
   * resolves to and the bundle serves changes through it; without it the
   * change channel refuses (the default), so a caller that reaches it learns
   * which assembly it needs. A tracker that is not geelib ignores this
   * option — its own tracker already carries the change channel.
   */
  changesTracker?: TrackerProvider;
}

export function createProviderBundle(
  tracker: TrackerProvider,
  repoRoot: string,
  options: ProviderBundleOptions = {},
): ProviderBundle {
  const backlog = tracker.platform === 'github'
    ? new GitHubBacklogProvider(tracker, options)
    : tracker.platform === 'gitlab'
      ? new GitLabBacklogProvider(tracker, options)
      : new GeelibBacklogProvider(tracker as unknown as GeelibBacklogClient);
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
    // Hybrid mode: a geelib item's change request lives on the git platform,
    // so the bundle carries the tracker of that platform when the caller
    // resolved one, and a change channel that says so otherwise — instead of
    // letting the git-shaped provider guess.
    changes: tracker.platform === 'geelib'
      ? (options.changesTracker
        ? new TrackerChangeProvider(options.changesTracker)
        : new RefusingChangeProvider())
      : new TrackerChangeProvider(tracker),
  };
}

export function createManagementProviderBundle(
  tracker: TrackerProvider,
  repoRoot: string,
): ManagementProviderBundle {
  return asManagementProviders(createProviderBundle(tracker, repoRoot));
}

export function asManagementProviders(providers: ProviderBundle): ManagementProviderBundle {
  return { ...providers, backlog: new ManagementBacklogProvider(providers.backlog) };
}
