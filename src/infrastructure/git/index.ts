/**
 * Git utilities.
 */
import { WorktreeManager } from './worktree';
export { WorktreeManager };
export type { Worktree, WorktreeState, CleanOptions } from './worktree';

/**
 * Factory: create a WorktreeManager instance.
 * The repoPath defaults to process.cwd() to match the class default.
 * Tests may inject a fake via RunnerDependencies.worktree instead.
 */
export function createWorktreeManager(repoPath?: string): WorktreeManager {
  return new WorktreeManager(repoPath);
}
