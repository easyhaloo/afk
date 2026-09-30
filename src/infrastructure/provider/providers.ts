import type { TrackerProvider } from '../../domain/tracker/types.js';
import type { BacklogProvider, QABacklogProvider } from '../../domain/backlog/index.js';
import { GitHubBacklogProvider } from '../../domain/backlog/github-provider.js';
import { GitLabBacklogProvider } from '../../domain/backlog/gitlab-provider.js';
import { ManagementBacklogProvider } from '../../domain/backlog/management-provider.js';
import type { AtomicClaim, ClaimLock, ClaimLockFactory } from '../../domain/backlog/claim-strategy.js';
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
  return {
    backlog: tracker.platform === 'github'
      ? new GitHubBacklogProvider(tracker, options)
      : new GitLabBacklogProvider(tracker, options),
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
