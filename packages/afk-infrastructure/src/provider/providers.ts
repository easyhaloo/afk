import type { TrackerProvider } from '@afk/application';
import type { BacklogProvider, QABacklogProvider } from '@afk/application';
import { ManagementBacklogProvider } from '../backlog/management-provider.js';
import { TrackerBacklogProvider } from '../backlog/tracker-adapter.js';
import type { AtomicClaim, ClaimLock, ClaimLockFactory } from '../backlog/claim-strategy.js';
import type { BranchProvider } from '../git/branches/provider.js';
import { GitBranchProvider } from '../git/branches/git-provider.js';
import type { ChangeProvider } from '../tracker/changes/provider.js';
import { TrackerChangeProvider } from '../tracker/changes/tracker-adapter.js';

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
  tracker: TrackerProvider,
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
  tracker: TrackerProvider,
  repoRoot: string,
): ManagementProviderBundle {
  return {
    backlog: new ManagementBacklogProvider(createProviderBundle(tracker, repoRoot).backlog),
    branches: new GitBranchProvider(repoRoot),
    changes: new TrackerChangeProvider(tracker),
  };
}
