/**
 * Shared helpers for BranchStrategy implementations.
 *
 * Worktree add / remove / list primitives + concurrency guard that refuses
 * to share a writable branch between two prepareWorktree() calls.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import type { SimpleGit } from 'simple-git';
import { BranchStrategyError } from './types.js';
import { resolveWorkspaceRoot, workspaceDataDirectory } from '../../shared/workspace-paths.js';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';

/** Track the worktrees the running attempts have prepared, so that two
 *  concurrent attempts refuse to share a writable branch.
 *
 *  A claim belongs to the attempt that took it and ends with that attempt.
 *  An attempt that keeps its worktree for evidence keeps the files, not the
 *  claim: a claim that outlives its attempt refuses the next attempt of the
 *  same item with a double-prepare error instead of the failure that really
 *  happened — and the item can never be verified again in that process. */
const preparedWorktrees = new Map<string, string>(); // path -> branch

/** Default base dir for worktrees, relative to repoPath. */
export function defaultWorktreeBaseDir(repoPath: string): string {
  const executionRoot = resolveWorkspaceRoot();
  const location = relative(executionRoot, repoPath);
  return !location.startsWith('..') && !isAbsolute(location)
    ? join(repoPath, '.worktrees')
    : join(executionRoot, 'repositories', basename(workspaceDataDirectory(repoPath)), '.worktrees');
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
      // A stale worktree path can be retried, but an existing branch is
      // intentionally never deleted here: it may contain unpushed work.
      try { await git.raw(['worktree', 'remove', worktreePath, '--force']); } catch { /* ignore */ }
      await git.raw(['worktree', 'add', '-b', branch, worktreePath, baseBranch]);
    } else {
      throw new BranchStrategyError(`worktree add failed: ${msg}`, kind as never, err);
    }
  }
}

/**
 * Whether the local repository has the branch.
 *
 * The remote's branch is a different fact: a published change request has a
 * remote branch even when the local checkout has never seen it.
 */
export async function localBranchExists(git: SimpleGit, branch: string): Promise<boolean> {
  const ref = `refs/heads/${branch}`;
  const listed = await git.raw(['for-each-ref', '--format=%(refname)', ref]).catch(() => '');
  return listed.trim() === ref;
}

/**
 * The worktrees this repository knows about, with the branch each one holds.
 *
 * Git prints the resolved path of a worktree, which is not always the path
 * AFK asked for: a link anywhere in the path is resolved before Git records
 * it. Comparing the paths as they are therefore compares two different
 * strings for the same worktree.
 */
export async function listWorktrees(git: SimpleGit): Promise<{ path: string; branch?: string }[]> {
  const listing = await git.raw(['worktree', 'list', '--porcelain']).catch(() => '');
  const entries: { path: string; branch?: string }[] = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of listing.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length).trim() };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).trim();
    }
  }
  return entries;
}

/** The path with every link in it resolved, the way Git records it. */
async function resolvedPath(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    // The path itself may be gone already; the links in its parent are not.
    const parent = await fs.realpath(dirname(path)).catch(() => undefined);
    return parent ? join(parent, basename(path)) : resolve(path);
  }
}

/** Whether the repository knows the path as one of its worktrees. */
export async function isWorktreePath(git: SimpleGit, path: string): Promise<boolean> {
  const target = await resolvedPath(path);
  for (const entry of await listWorktrees(git)) {
    if (await resolvedPath(entry.path) === target) return true;
  }
  return false;
}

/**
 * Remove the worktrees that have the branch checked out.
 *
 * Git refuses to check the same branch out twice, so a branch an earlier
 * attempt left behind has to be released before it can be used again. The
 * worktree is AFK's own scratch space for that branch, and the work in it is
 * reproduced by the attempt that follows.
 */
export async function removeWorktreesHoldingBranch(git: SimpleGit, branch: string): Promise<void> {
  for (const entry of await listWorktrees(git)) {
    if (entry.branch === `refs/heads/${branch}`) {
      await git.raw(['worktree', 'remove', entry.path, '--force']).catch(() => undefined);
    }
  }
  await git.raw(['worktree', 'prune']).catch(() => undefined);
}

/**
 * Release the worktree registered at the path, whatever branch it holds.
 *
 * Git refuses to check a branch out into a path that already is a worktree,
 * so the earlier attempt's worktree has to be released before the path can
 * be used again.
 */
export async function removeWorktreeAtPath(git: SimpleGit, path: string): Promise<void> {
  const target = await resolvedPath(path);
  for (const entry of await listWorktrees(git)) {
    if (await resolvedPath(entry.path) === target) {
      await git.raw(['worktree', 'remove', entry.path, '--force']).catch(() => undefined);
    }
  }
  await git.raw(['worktree', 'prune']).catch(() => undefined);
}

/**
 * Remove a directory that Git does not know as a worktree.
 *
 * Git refuses to check a branch out into a directory that still holds files.
 * Such a directory is the leftover of an earlier attempt — the worktree it
 * prepared was released, the files it held stayed — and it is AFK's own
 * scratch space for that branch. The evidence the attempt gathered was
 * already reported by the attempt that kept it.
 */
export async function removeLeftoverDirectory(path: string, baseDir: string): Promise<void> {
  const location = relative(baseDir, path);
  if (location === '' || location.startsWith('..') || isAbsolute(location)) return;
  const entries = await fs.readdir(path).catch(() => []);
  // Git checks a branch out into an empty directory just fine.
  if (entries.length === 0) return;
  await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
}

/**
 * Remove a worktree. Idempotent — a path that is not a worktree is swallowed.
 *
 * Whether the path is a worktree is a question the repository answers, not
 * something Git's exit code says: a localized Git reports "not a working
 * tree" in its own words, and AFK does not parse Git's sentences.
 */
export async function gitWorktreeRemove(git: SimpleGit, path: string, force = false): Promise<void> {
  const target = await resolvedPath(path);
  let registered: string | undefined;
  for (const entry of await listWorktrees(git)) {
    if (await resolvedPath(entry.path) === target) {
      registered = entry.path;
      break;
    }
  }
  if (!registered) return;
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  // Git is given the path it recorded, so it finds the worktree even when
  // AFK reaches it through a link.
  args.push(registered);
  await git.raw(args);
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

/** Release the claim an attempt took on a worktree path.
 *
 *  Called when the attempt ends — whether it deletes the worktree or keeps
 *  it for evidence. The claim is about the running attempt, not about the
 *  files on disk. */
export function releasePath(path: string): void {
  preparedWorktrees.delete(path);
}

/**
 * Run a preparation, releasing the sharing guard when it fails.
 *
 * The guard is what keeps two concurrent steps off one branch, so it is taken
 * before the worktree is created. A preparation that fails must give it back:
 * the attempt that follows has to be able to try again, and a guard that
 * outlived its attempt would refuse the retry with a message about a double
 * prepare rather than about the failure that really happened.
 */
export async function releasingPathOnFailure<Result>(path: string, prepare: () => Promise<Result>): Promise<Result> {
  try {
    return await prepare();
  } catch (error) {
    releasePath(path);
    throw error;
  }
}

/** Clear ALL prepared-worktree guards — used by tests to isolate state
 *  between cases. Production code must not call this. */
export function _clearPreparedWorktreesForTest(): void {
  preparedWorktrees.clear();
}
