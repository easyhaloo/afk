import type { BacklogItem } from '../../../domain/backlog/index.js';

export interface BranchHandle {
  branchName: string;
  worktreePath: string;
}

/**
 * What a fallback commit did with what the agent left in the worktree.
 */
export interface BranchCommitResult {
  /** The new commit; empty when there was nothing to commit. */
  sha: string;
  /**
   * Binary files the commit left out.
   *
   * A leftover binary has no text to merge: when the target branch touched
   * the same file, the change request can never be merged and nobody can
   * resolve it by hand either. Publishing such a file is therefore worse
   * than reporting it.
   */
  skippedBinaryFiles: string[];
}

/**
 * What happened when the feature branch was merged onto the baseline.
 */
export interface BaselineMergeResult {
  merged: boolean;
  /**
   * Files that still conflict. The merge is left in progress, so the caller
   * can resolve them in the worktree where they belong.
   */
  conflicts: string[];
}

export interface BranchProvider {
  createBranch(item: BacklogItem, baseBranch: string): Promise<BranchHandle>;
  /** Create an isolated, disposable verification worktree from the base branch. */
  createVerificationWorktree(item: BacklogItem, baseBranch: string): Promise<BranchHandle>;
  push(branchName: string, worktreePath: string): Promise<void>;
  commit(worktreePath: string, message: string): Promise<BranchCommitResult>;
  cleanup(worktreePath: string, options?: { preserve?: boolean }): Promise<void>;
  /**
   * Put the baseline in the worktree and merge the feature branch into it.
   *
   * A conflict leaves the merge in progress and names the files that still
   * conflict, so the caller can resolve them where they belong instead of
   * publishing a change request that can never land.
   */
  mergeFeatureIntoBaseline(
    worktreePath: string,
    baselineBranch: string,
    featureBranch: string,
  ): Promise<BaselineMergeResult>;
  /** Files that still carry conflict markers in the worktree. */
  listUnresolvedConflicts(worktreePath: string): Promise<string[]>;
}
