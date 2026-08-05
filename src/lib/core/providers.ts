import type { TrackerProvider } from './tracker/types';
import type { BacklogProvider, QABacklogProvider } from './backlog';
import { GitHubBacklogProvider } from './backlog/github-provider';
import { GitLabBacklogProvider } from './backlog/gitlab-provider';
import { ManagementBacklogProvider } from './backlog/management-provider';
import type { AtomicClaim, ClaimLock, ClaimLockFactory } from './backlog/claim-strategy';
import type { BranchProvider } from './branches/provider';
import { GitBranchProvider } from './branches/git-provider';
import type { ChangeProvider } from './changes/provider';
import { TrackerChangeProvider } from './changes/tracker-adapter';

export interface ProviderBundle {
  backlog: BacklogProvider;
  branches: BranchProvider;
  changes: ChangeProvider;
}

/** Bundle for backlog administration and QA; its backlog has no claim() path. */
export interface ManagementProviderBundle {
  backlog: QABacklogProvider;
  branches: BranchProvider;
  changes: ChangeProvider;
}

export interface ProviderBundleOptions {
  /** Provider-native conditional claim. The filesystem lease is used when absent. */
  atomicClaim?: AtomicClaim;
  /** Optional preconfigured local lease (primarily useful for tests/embedding). */
  claimLock?: ClaimLock;
  /** Factory receiving the provider-qualified expiry recovery callback. */
  claimLockFactory?: ClaimLockFactory;
  /** Duration of the local fallback lease. */
  claimTtlMs?: number;
}

export function createProviderBundle(tracker: TrackerProvider, repoRoot: string, options: ProviderBundleOptions = {}): ProviderBundle {
  return {
    backlog: tracker.platform === 'github'
      ? new GitHubBacklogProvider(tracker, options)
      : new GitLabBacklogProvider(tracker, options),
    branches: new GitBranchProvider(repoRoot),
    changes: new TrackerChangeProvider(tracker),
  };
}

/** Backlog administration and QA bundle with a physical claim-free facade. */
export function createManagementProviderBundle(tracker: TrackerProvider, repoRoot: string): ManagementProviderBundle {
  return {
    backlog: new ManagementBacklogProvider(createProviderBundle(tracker, repoRoot).backlog),
    branches: new GitBranchProvider(repoRoot),
    changes: new TrackerChangeProvider(tracker),
  };
}
