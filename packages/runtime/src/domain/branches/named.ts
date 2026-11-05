/**
 * NamedBranchStrategy — user-provided branch name. Worktree path mirrors the
 * branch name (with `/` -> `-` translation). Refuses reserved prefixes
 * (HEAD, afk/issue-, master-protect) to prevent the agent from clobbering
 * protected branches.
 */

import { join } from 'path';
import type { SimpleGit } from 'simple-git';
import type {
  BranchStrategy,
  BranchStrategyConfig,
  BranchHandle,
  PrepareOptions,
  FinalizeOptions,
  CleanupOptions,
} from './types.js';
import { BranchStrategyError, RESERVED_BRANCH_PREFIXES } from './types.js';
import {
  defaultWorktreeBaseDir,
  ensureWorktreeBaseDir,
  gitWorktreeAdd,
  gitWorktreeRemove,
  gitBranchDelete,
  checkNotShared,
  localBranchExists,
  removeWorktreesHoldingBranch,
  releasingPathOnFailure,
  releasePath,
} from './base.js';

export class NamedBranchStrategy implements BranchStrategy {
  readonly kind = 'named' as const;

  resolveBranch(config: BranchStrategyConfig): string {
    if (config.type !== 'named') throw new Error('NamedBranchStrategy requires config.type === "named"');
    return config.branch;
  }

  private validate(branch: string): void {
    if (!branch || branch.includes('..') || branch.includes('~') || branch.includes('^') || branch.includes(':')) {
      throw new BranchStrategyError(`invalid branch name: '${branch}'`, this.kind);
    }
    for (const prefix of RESERVED_BRANCH_PREFIXES) {
      if (branch === prefix || branch.startsWith(prefix)) {
        throw new BranchStrategyError(
          `branch '${branch}' uses reserved prefix '${prefix}'`,
          this.kind,
        );
      }
    }
  }

  async prepareWorktree(git: SimpleGit, config: BranchStrategyConfig, options: PrepareOptions): Promise<BranchHandle> {
    if (config.type !== 'named') throw new Error('NamedBranchStrategy requires config.type === "named"');
    this.validate(config.branch);
    const branch = this.resolveBranch(config);
    const baseDir = options.worktreeBaseDir ?? defaultWorktreeBaseDir(options.repoPath);
    await ensureWorktreeBaseDir(baseDir);
    // Mirror the branch name as a directory; '/' is path-illegal so use '-'.
    const dirName = branch.replace(/\//g, '-');
    const path = join(baseDir, dirName);

    checkNotShared(path, branch, this.kind);
    const baseBranch = options.baseBranch ?? config.baseBranch ?? 'main';
    return releasingPathOnFailure(path, async () => {
      if (options.reuseExistingBranch && await localBranchExists(git, branch)) {
        // The branch is the one an earlier attempt published its change
        // request from. The verification reuses that change request and
        // refreshes its evidence, so it checks the branch out again instead
        // of creating a second one that Git would refuse.
        await removeWorktreesHoldingBranch(git, branch);
        await git.raw(['worktree', 'add', path, branch]);
        return { branch, path, isNewBranch: false };
      }
      await gitWorktreeAdd(git, branch, path, baseBranch, this.kind);
      return { branch, path, isNewBranch: true };
    });
  }

  async finalize(_git: SimpleGit, _config: BranchStrategyConfig, _handle: BranchHandle, _options?: FinalizeOptions): Promise<void> {
    // Named strategy: agent pushes the branch; finalize is a no-op.
  }

  async cleanup(git: SimpleGit, _config: BranchStrategyConfig, handle: BranchHandle, options?: CleanupOptions): Promise<void> {
    await gitWorktreeRemove(git, handle.path, options?.force ?? false);
    if (!options?.keepBranch) {
      await gitBranchDelete(git, handle.branch, options?.force ?? false);
    }
    releasePath(handle.path);
  }
}