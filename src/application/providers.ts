import type { TrackerProvider } from '../domain/tracker/types';
import type { BacklogProvider, QABacklogProvider } from '../domain/backlog';
import { GitHubBacklogProvider } from '../domain/backlog/github-provider';
import { GitLabBacklogProvider } from '../domain/backlog/gitlab-provider';
import { ManagementBacklogProvider } from '../domain/backlog/management-provider';
import type { AtomicClaim, ClaimLock, ClaimLockFactory } from '../domain/backlog/claim-strategy';
import type { BranchProvider } from '../infrastructure/git/branches/provider';
import { GitBranchProvider } from '../infrastructure/git/branches/git-provider';
import type { ChangeProvider } from '../infrastructure/tracker/changes/provider';
import { TrackerChangeProvider } from '../infrastructure/tracker/changes/tracker-adapter';

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
