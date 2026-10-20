/**
 * ExistingBranchStrategy — reuse an existing branch (and optionally its
 * worktree path). Refuses to attach if:
 *   - the branch is already checked out in another worktree
 *   - the optional worktree path doesn't already exist
 *   - the optional worktree path is on a different branch
 *
 * Use case: resume an in-progress run, or run a workflow against a branch
 * the user has been working on manually.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  BranchStrategy,
  BranchStrategyConfig,
  BranchHandle,
  PrepareOptions,
  FinalizeOptions,
  CleanupOptions,
} from './types.js';
import { BranchStrategyError } from './types.js';
import {
  defaultWorktreeBaseDir,
  ensureWorktreeBaseDir,
  gitBranchDelete,
  gitWorktreeRemove,
  checkNotShared,
  isBranchCheckedOut,
  releasePath,
} from './base.js';

export class ExistingBranchStrategy implements BranchStrategy {
  readonly kind = 'existing' as const;

  resolveBranch(config: BranchStrategyConfig): string {
    if (config.type !== 'existing') throw new Error('ExistingBranchStrategy requires config.type === "existing"');
    return config.branch;
  }

  async prepareWorktree(git: SimpleGit, config: BranchStrategyConfig, options: PrepareOptions): Promise<BranchHandle> {
    if (config.type !== 'existing') throw new Error('ExistingBranchStrategy requires config.type === "existing"');
    const branch = config.branch;

    // 1. Branch must exist.
    const branches = (await git.raw(['branch', '--list', branch])).trim();
    if (!branches) {
      throw new BranchStrategyError(`branch '${branch}' does not exist`, this.kind);
    }

    // 2. Branch must NOT be checked out in another worktree.
    if (await isBranchCheckedOut(git, branch)) {
      throw new BranchStrategyError(
        `branch '${branch}' is already checked out in another worktree`,
        this.kind,
      );
    }

    // 3. Resolve worktree path: explicit > default sibling.
    const baseDir = options.worktreeBaseDir ?? defaultWorktreeBaseDir(options.repoPath);
    await ensureWorktreeBaseDir(baseDir);
    const path = config.worktreePath ?? join(baseDir, branch.replace(/\//g, '-'));

    checkNotShared(path, branch, this.kind);

    if (config.worktreePath) {
      // Verify the caller-supplied path exists AND is on the right branch.
      try {
        await fs.access(config.worktreePath);
      } catch {
        throw new BranchStrategyError(
          `provided worktree path '${config.worktreePath}' does not exist`,
          this.kind,
        );
      }
      const wtGit = simpleGit(config.worktreePath);
      const currentBranch = (await wtGit.revparse(['--abbrev-ref', 'HEAD'])).trim();
      if (currentBranch !== branch) {
        throw new BranchStrategyError(
          `worktree '${config.worktreePath}' is on branch '${currentBranch}', not '${branch}'`,
          this.kind,
        );
      }
    } else {
      // No path given — attach a new worktree to the existing branch.
      await git.raw(['worktree', 'add', path, branch]);
    }

    return { branch, path, isNewBranch: false };
  }

  async finalize(_git: SimpleGit, _config: BranchStrategyConfig, _handle: BranchHandle, _options?: FinalizeOptions): Promise<void> {
    // Existing branch: agent pushes the branch; finalize is a no-op.
  }

  async cleanup(git: SimpleGit, _config: BranchStrategyConfig, handle: BranchHandle, options?: CleanupOptions): Promise<void> {
    // The worktree is ours to remove — we attached it. The branch is not:
    // it existed before the run, so it is kept unless the caller asks for
    // it to go. Deleting it by default would throw away work that was
    // there before AFK touched it.
    await gitWorktreeRemove(git, handle.path, options?.force ?? false);
    if (options?.keepBranch === false) {
      await gitBranchDelete(git, handle.branch, true);
    }
    releasePath(handle.path);
  }
}