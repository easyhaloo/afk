import type { TrackerIssueOperations, TrackerMergeReader, TrackerMergeWriter } from '@afk/application';
import type { BacklogProvider, QABacklogProvider } from '@afk/application';
import { ManagementBacklogProvider } from '../backlog/management-provider.js';
import { TrackerBacklogProvider } from '../backlog/tracker-adapter.js';
import type { AtomicClaim, ClaimLock, ClaimLockFactory } from '../backlog/claim-strategy.js';
import type { BranchProvider } from '../git/branches/provider.js';
import { GitBranchProvider } from '../git/branches/git-provider.js';
import type { ChangeProvider } from '../tracker/changes/provider.js';
import { TrackerChangeProvider } from '../tracker/changes/tracker-adapter.js';

/**
 * The tracker this bundle needs: the backlog adapter reads and writes
 * issues and reads merge requests; the changes adapter writes merge
 * requests.  The bundle says so once, and neither adapter has to ask for
 * the whole tracker to get it.
 */
export type BundleTracker = TrackerIssueOperations & TrackerMergeReader & TrackerMergeWriter;

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
}

export function createProviderBundle(
  tracker: BundleTracker,
  repoRoot: string,
  options: ProviderBundleOptions = {},
): ProviderBundle {
  if (tracker.platform !== 'github' && tracker.platform !== 'gitlab') {
    throw new Error(`createProviderBundle requires a GitHub or GitLab tracker client, got '${tracker.platform}'`);
  }
  return {
    // One backlog implementation, whichever platform the tracker speaks. The
    // two platform classes that used to sit here differed by three lines and
    // forwarded every method without adding any behaviour.
    backlog: new TrackerBacklogProvider(tracker, options),
    branches: new GitBranchProvider(repoRoot),
    changes: new TrackerChangeProvider(tracker),
  };
}

export function createManagementProviderBundle(
  tracker: BundleTracker,
  repoRoot: string,
): ManagementProviderBundle {
  return {
    backlog: new ManagementBacklogProvider(createProviderBundle(tracker, repoRoot).backlog),
    branches: new GitBranchProvider(repoRoot),
    changes: new TrackerChangeProvider(tracker),
  };
}
