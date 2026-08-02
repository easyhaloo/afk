/**
 * Shared helpers for BranchStrategy implementations.
 *
 * Worktree add / remove / list primitives + concurrency guard that refuses
 * to share a writable branch between two prepareWorktree() calls.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { SimpleGit } from 'simple-git';
import { BranchStrategyError } from './types';

/** Track worktrees that have been prepared in the current process so that
 *  concurrent calls refuse to share a writable branch. */
const preparedWorktrees = new Map<string, string>(); // path -> branch

/** Default base dir for worktrees, relative to repoPath. */
export function defaultWorktreeBaseDir(repoPath: string): string {
  return join(repoPath, '.worktrees');
}

/** Make sure the worktreeBaseDir exists. */
export async function ensureWorktreeBaseDir(path: string): Promise<void> {
  await fs.mkdir(path, { recursive: true });
}

/**
 * Add a new worktree. Mirrors the retry-on-stale behavior in WorktreeManager
 * (a previous failed retry leaves a checked-out branch + worktree that must
 * be cleaned before re-adding).
 */
export async function gitWorktreeAdd(
  git: SimpleGit,
  branch: string,
  worktreePath: string,
  baseBranch: string,
  kind: string,
): Promise<void> {
  try {
    await git.raw(['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
  } catch (err: unknown) {
    const msg = String(err);
    if (msg.includes('already exists') || msg.includes('already exists') || msg.includes('已经存在')) {
      // Stale branch + worktree from a failed retry. Clean and retry once.
      try { await git.raw(['worktree', 'remove', worktreePath, '--force']); } catch { /* ignore */ }
      try { await git.raw(['branch', '-D', branch]); } catch { /* ignore */ }
      await git.raw(['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
    } else {
      throw new BranchStrategyError(`worktree add failed: ${msg}`, kind as never, err);
    }
  }
}

/** Remove a worktree. Idempotent — ENOENT and "not a working tree" are swallowed. */
export async function gitWorktreeRemove(git: SimpleGit, path: string, force = false): Promise<void> {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  try {
    await git.raw(args);
  } catch (err: unknown) {
    const msg = String(err);
    if (!/not a working tree/i.test(msg) && !/No such file/i.test(msg)) {
      throw err;
    }
  }
}

/** Delete a local branch. Idempotent — ENOENT/merged is swallowed. */
export async function gitBranchDelete(git: SimpleGit, branch: string, force = false): Promise<void> {
  try {
    await git.raw(['branch', force ? '-D' : '-d', branch]);
  } catch (err: unknown) {
    const msg = String(err);
    if (!/not found/i.test(msg) && !/No such branch/i.test(msg)) {
      throw err;
    }
  }
}

/** Check if a worktree is currently checked out (used by 'existing' strategy). */
export async function isBranchCheckedOut(git: SimpleGit, branch: string): Promise<boolean> {
  try {
    const out = await git.raw(['worktree', 'list', '--porcelain']);
    return out.split('\n').some(line => line === `branch refs/heads/${branch}`);
  } catch {
    return false;
  }
}

/** Refuse to share a writable branch between two concurrent strategies.
 *  Also refuse idempotent double-prepare (same path + same branch) — that
 *  indicates a misuse where the caller should reuse the existing handle. */
export function checkNotShared(path: string, branch: string, kind: string): void {
  const existing = preparedWorktrees.get(path);
  if (existing === branch) {
    throw new BranchStrategyError(
      `worktree path '${path}' is already prepared for branch '${branch}'; refusing double-prepare`,
      kind as never,
    );
  }
  if (existing && existing !== branch) {
    throw new BranchStrategyError(
      `worktree path '${path}' already prepared for branch '${existing}'; cannot reuse for '${branch}' (parallel steps must use independent worktrees)`,
      kind as never,
    );
  }
  // Also guard by branch name (different paths, same branch = same conflict).
  for (const [p, b] of preparedWorktrees.entries()) {
    if (b === branch && p !== path) {
      throw new BranchStrategyError(
        `branch '${branch}' is already prepared at '${p}'; refusing to reuse for '${path}'`,
        kind as never,
      );
    }
  }
  preparedWorktrees.set(path, branch);
}

/** Release the guard when cleanup() runs. */
export function releasePath(path: string): void {
  preparedWorktrees.delete(path);
}

/** Clear ALL prepared-worktree guards — used by tests to isolate state
 *  between cases. Production code must not call this. */
export function _clearPreparedWorktreesForTest(): void {
  preparedWorktrees.clear();
}