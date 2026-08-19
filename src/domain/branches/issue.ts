/**
 * IssueBranchStrategy — default strategy for issue-driven workflows.
 * Branch name: `afk-issue-<iid>`. Worktree path: `<baseDir>/issue-<iid>`.
 * Backward-compatible with WorktreeManager.create(iid, baseBranch).
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

export class IssueBranchStrategy implements BranchStrategy {
  readonly kind = 'issue' as const;

  resolveBranch(config: BranchStrategyConfig): string {
    if (config.type !== 'issue') throw new Error('IssueBranchStrategy requires config.type === "issue"');
    return `afk-issue-${config.iid}`;
  }

  async prepareWorktree(git: SimpleGit, config: BranchStrategyConfig, options: PrepareOptions): Promise<BranchHandle> {
    if (config.type !== 'issue') throw new Error('IssueBranchStrategy requires config.type === "issue"');
    const branch = this.resolveBranch(config);
    const baseDir = options.worktreeBaseDir ?? defaultWorktreeBaseDir(options.repoPath);
    await ensureWorktreeBaseDir(baseDir);
    const path = join(baseDir, `issue-${config.iid}`);

    checkNotShared(path, branch, this.kind);
    const baseBranch = options.baseBranch ?? 'main';
    await gitWorktreeAdd(git, branch, path, baseBranch, this.kind);

    return { branch, path, isNewBranch: true };
  }

  async finalize(_git: SimpleGit, _config: BranchStrategyConfig, _handle: BranchHandle, _options?: FinalizeOptions): Promise<void> {
    // Issue strategy: agent is expected to push the branch itself; finalize is a no-op.
  }

  async cleanup(git: SimpleGit, _config: BranchStrategyConfig, handle: BranchHandle, options?: CleanupOptions): Promise<void> {
    await gitWorktreeRemove(git, handle.path, options?.force ?? false);
    if (!options?.keepBranch) {
      await gitBranchDelete(git, handle.branch, options?.force ?? false);
    }
    releasePath(handle.path);
  }
}