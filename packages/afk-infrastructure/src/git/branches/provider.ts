import type { BacklogItem } from '@afk/application';

export interface ProviderBranchHandle {
  branchName: string;
  worktreePath: string;
}

export interface BranchProvider {
  createBranch(item: BacklogItem, baseBranch: string): Promise<ProviderBranchHandle>;
  /** Create an isolated, disposable verification worktree from the base branch. */
  createVerificationWorktree(item: BacklogItem, baseBranch: string): Promise<ProviderBranchHandle>;
  push(branchName: string, worktreePath: string): Promise<void>;
  commit(worktreePath: string, message: string): Promise<string>;
  cleanup(worktreePath: string, options?: { preserve?: boolean }): Promise<void>;
}
