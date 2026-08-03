/**
 * MergeToHeadBranchStrategy — no separate feature branch; agent works in a
 * scratch worktree branched off the current HEAD, and finalize() merges
 * the commits back to HEAD.
 *
 * Branch name: `afk-merge-<short-id>` (unique per run to avoid conflicts).
 * Worktree path: `<baseDir>/merge-<short-id>`.
 *
 * Use case: hotfix workflows where the user wants the agent's commits
 * directly on the current branch without an intermediate review branch.
 */

import { randomUUID } from 'crypto';
import { join } from 'path';
import type { SimpleGit } from 'simple-git';
import type {
  BranchStrategy,
  BranchStrategyConfig,
  BranchHandle,
  PrepareOptions,
  FinalizeOptions,
  CleanupOptions,
} from './types';
import {
  defaultWorktreeBaseDir,
  ensureWorktreeBaseDir,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitBranchDelete,
  checkNotShared,
  releasePath,
} from './base';

export class MergeToHeadBranchStrategy implements BranchStrategy {
  readonly kind = 'merge-to-head' as const;

  resolveBranch(_config: BranchStrategyConfig): string {
    // The branch is generated per-run (with randomUUID) so it's not stable
    // before prepareWorktree() runs; this method only documents the format.
    throw new Error('MergeToHeadBranchStrategy generates branch on prepareWorktree(); resolveBranch() requires a config');
  }

  async prepareWorktree(git: SimpleGit, config: BranchStrategyConfig, options: PrepareOptions): Promise<BranchHandle> {
    if (config.type !== 'merge-to-head') throw new Error('MergeToHeadBranchStrategy requires config.type === "merge-to-head"');

    const shortId = randomUUID().slice(0, 8);
    const branch = `afk-merge-${shortId}`;
    const baseDir = options.worktreeBaseDir ?? defaultWorktreeBaseDir(options.repoPath);
    await ensureWorktreeBaseDir(baseDir);
    const path = join(baseDir, `merge-${shortId}`);

    checkNotShared(path, branch, this.kind);

    // Branch off the current HEAD, not the configured baseBranch (merge-to-head
    // is defined by "where HEAD points NOW"). We capture HEAD's sha at this
    // moment and use it as the fork point.
    const headSha = await git.revparse(['HEAD']);
    await gitWorktreeAdd(git, branch, path, headSha, this.kind);

    void config; // silence unused
    return { branch, path, isNewBranch: true };
  }

  async finalize(git: SimpleGit, _config: BranchStrategyConfig, handle: BranchHandle, options?: FinalizeOptions): Promise<void> {
    // Merge handle.branch back to HEAD (or mergeTarget).
    const target = options?.mergeTarget ?? 'HEAD';
    // Use --no-ff to preserve the merge commit; gives downstream tools a clear
    // "AFK contributed this set of commits" signal in the history.
    await git.raw(['merge', '--no-ff', '--no-edit', '-m', `Merge ${handle.branch}`, handle.branch]);

    if (options?.push) {
      // Push the target branch to origin (best-effort; many test repos have no remote).
      try {
        await git.raw(['push', 'origin', target]);
      } catch {
        // ignore: no remote in unit tests
      }
    }
  }

  async cleanup(git: SimpleGit, _config: BranchStrategyConfig, handle: BranchHandle, options?: CleanupOptions): Promise<void> {
    await gitWorktreeRemove(git, handle.path, options?.force ?? false);
    // Always delete the merge branch — it's a scratch branch by definition.
    await gitBranchDelete(git, handle.branch, true);
    releasePath(handle.path);
  }
}