/**
 * Branch strategy types — abstraction over git worktree + branch lifecycle
 * (EXECUTION-DESIGN.md §9 / §12 阶段 6).
 *
 * Four built-in strategies:
 *   - issue         default; branch = afk-issue-<iid>, worktree = .worktrees/issue-<iid>
 *   - named         user-provided branch name; worktree = .worktrees/<branch>
 *   - merge-to-head no separate branch; merge directly back to current HEAD
 *   - existing      reuse an existing branch (+ optional worktree path)
 *
 * Lifecycle contract (matches the design's strategy responsibilities):
 *   resolveBranch()    -> branch name
 *   prepareWorktree()  -> { branch, path } (creates worktree if needed)
 *   finalize()         -> merge / push / archive (after agent completes)
 *   cleanup()          -> remove worktree + branch per the strategy
 *
 * Important design rule: "session fork 不等于 branch fork, branch fork
 * 不等于 sandbox fork. 并行步骤必须显式使用独立 branch/worktree." Each
 * strategy MUST refuse to share a writable branch between concurrent
 * prepareWorktree() calls; the runner enforces this.
 */

import type { SimpleGit } from 'simple-git';

/** Strategy kind discriminator. */
export type BranchStrategyKind = 'issue' | 'named' | 'merge-to-head' | 'existing';

/** Discriminated union: each variant carries its specific config. */
export type BranchStrategyConfig =
  | { type: 'issue'; iid: number }
  | { type: 'named'; branch: string; baseBranch?: string }
  | { type: 'merge-to-head'; baseBranch?: string }
  | { type: 'existing'; branch: string; worktreePath?: string };

/** Resolved branch + worktree handle returned by prepareWorktree(). */
export interface BranchHandle {
  branch: string;
  /** Worktree path on the host filesystem. */
  path: string;
  /** Whether this strategy created a NEW branch (vs reusing an existing one). */
  isNewBranch: boolean;
}

/** Options for prepareWorktree(). */
export interface PrepareOptions {
  /** Repository root (where `git worktree add` runs from). */
  repoPath: string;
  /** Base branch to fork from (default: HEAD). */
  baseBranch?: string;
  /** Directory under which worktrees are placed (default: <repoPath>/.worktrees). */
  worktreeBaseDir?: string;
}

/** Options for finalize(). */
export interface FinalizeOptions {
  /** Where the agent pushed the branch (default: skip push for merge-to-head). */
  push?: boolean;
  /** Target branch for merge-to-head strategy (default: current HEAD). */
  mergeTarget?: string;
}

/** Options for cleanup(). */
export interface CleanupOptions {
  /** Force-remove even with uncommitted changes (used by error paths). */
  force?: boolean;
  /** Keep the branch after worktree removal (used by 'existing'). */
  keepBranch?: boolean;
}

/**
 * Strategy contract. Each implementation lives in its own file under ./;
 * the registry maps BranchStrategyKind -> constructor.
 */
export interface BranchStrategy {
  readonly kind: BranchStrategyKind;

  /** Compute the branch name without touching the filesystem. */
  resolveBranch(config: BranchStrategyConfig): string;

  /**
   * Prepare the branch + worktree. Creates both if needed; for 'existing'
   * it may just verify the worktree is reachable.
   * Throws if the strategy is misused (e.g., 'existing' on a checked-out branch).
   */
  prepareWorktree(git: SimpleGit, config: BranchStrategyConfig, options: PrepareOptions): Promise<BranchHandle>;

  /** Finalize after the agent completes: merge / push / archive per strategy. */
  finalize(git: SimpleGit, config: BranchStrategyConfig, handle: BranchHandle, options?: FinalizeOptions): Promise<void>;

  /** Remove the worktree (and optionally the branch). Idempotent. */
  cleanup(git: SimpleGit, config: BranchStrategyConfig, handle: BranchHandle, options?: CleanupOptions): Promise<void>;
}

/** Errors thrown by strategies. Distinct types so the runner can react specifically. */
export class BranchStrategyError extends Error {
  constructor(message: string, public readonly kind: BranchStrategyKind, public readonly cause?: unknown) {
    super(`[${kind}] ${message}`);
    this.name = 'BranchStrategyError';
  }
}

/** Reserved branch name prefixes that 'named' refuses to touch. */
export const RESERVED_BRANCH_PREFIXES = [
  'HEAD',
  'afk/issue-',
  'afk-issue-', // legacy
  'master-protect',
  'main-protect',
];