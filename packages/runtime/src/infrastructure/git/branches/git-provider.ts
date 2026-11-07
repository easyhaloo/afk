import { appendFile, lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { BacklogItem } from '../../../domain/backlog/index.js';
import { logger } from '../../io/index.js';
import type {
  BranchProvider,
  BranchHandle,
  BranchCommitResult,
  BaselineMergeResult,
} from './provider.js';
import { strategyForConfig } from '../../../domain/branches/registry.js';
import { releasePath } from '../../../domain/branches/base.js';
import type { BranchHandle as StrategyHandle } from '../../../domain/branches/types.js';
import { isAncestorCommit } from '../git-ancestry.js';
import { linkNodeModules } from '../dependency-pool.js';

export class GitBranchProvider implements BranchProvider {
  private readonly handles = new Map<string, StrategyHandle>();

  constructor(private readonly repoRoot: string) {}

  async createBranch(item: BacklogItem, baseBranch: string): Promise<BranchHandle> {
    const git = simpleGit(this.repoRoot);
    if (await refExists(git, item.branchName)) {
      const config = {
        type: 'existing' as const,
        branch: item.branchName,
      };
      const strategy = strategyForConfig(config);
      const handle = await strategy.prepareWorktree(git, config, { repoPath: this.repoRoot });
      this.handles.set(handle.path, handle);
      return { branchName: handle.branch, worktreePath: handle.path };
    }
    const config = {
      type: 'named' as const,
      branch: item.branchName,
      baseBranch: await this.resolveBaseBranch(item.branchName, baseBranch),
    };
    const strategy = strategyForConfig(config);
    const handle = await strategy.prepareWorktree(git, config, { repoPath: this.repoRoot, baseBranch: config.baseBranch });
    this.handles.set(handle.path, handle);
    return { branchName: handle.branch, worktreePath: handle.path };
  }

  async createVerificationWorktree(item: BacklogItem, baseBranch: string): Promise<BranchHandle> {
    const git = simpleGit(this.repoRoot);
    const verificationBase = await this.resolveVerificationBaseBranch(git, baseBranch);
    const config = { type: 'named' as const, branch: `${item.branchName}-qa`, baseBranch: verificationBase };
    const strategy = strategyForConfig(config);
    // The verification branch is the branch an earlier attempt published its
    // change request from. When it is still there, the verification reuses
    // that change request and refreshes its evidence — the merge into the
    // baseline rewrites the branch anyway — instead of failing to create a
    // second branch with the same name.
    const handle = await strategy.prepareWorktree(git, config, {
      repoPath: this.repoRoot, baseBranch: verificationBase, reuseExistingBranch: true,
    });
    await shareNodeModules(this.repoRoot, handle.path);
    this.handles.set(handle.path, handle);
    return { branchName: handle.branch, worktreePath: handle.path };
  }

  async push(branchName: string, worktreePath: string): Promise<void> {
    const git = simpleGit(worktreePath);
    await git.fetch('origin');
    const remoteBranch = `origin/${branchName}`;
    if (await refExists(git, remoteBranch)) {
      const localHead = (await git.revparse(['HEAD'])).trim();
      const remoteHead = (await git.revparse([remoteBranch])).trim();
      if (localHead !== remoteHead) {
        if (await isAncestorCommit(git, localHead, remoteHead)) {
          await git.merge(['--ff-only', remoteBranch]);
        } else if (!(await isAncestorCommit(git, remoteHead, localHead))) {
          await git.merge([remoteBranch, '--no-edit']);
        }
      }
    }
    await git.push('origin', branchName);
  }

  async commit(worktreePath: string, message: string): Promise<BranchCommitResult> {
    const git = simpleGit(worktreePath);
    // AFK's own runtime artifacts live in the worktree: the completion signal
    // the agent writes, the artifact manifest the QA runner reads, and the
    // worktrees AFK keeps inside the checkout. They are process state, not
    // work — publishing them would put them in the change request. A nested
    // worktree is worse than noise: Git stages it as a submodule pointer, so
    // the change request would carry a submodule nobody can clone.
    //
    // They are unstaged after the add rather than named in the add's
    // pathspec. Git refuses to add a path that is ignored, and the checkout
    // ignores its own worktree directory (ADR-0030) — so a pathspec that
    // names it fails the whole commit with "the following paths are ignored
    // by one of your .gitignore files", and nothing gets published at all.
    await git.raw(['add', '-A', '--', '.']);
    // Unstaging leaves a file that is already tracked exactly as it was, so
    // the artifact stays out of the change request without being deleted
    // from the user's repository.
    await git.raw(['reset', '-q', '--', '.afk-signal.json', '.afk']).catch(() => undefined);
    // The worktree directory is dropped from the index rather than unstaged:
    // an earlier attempt may have tracked it before it was excluded, and a
    // tracked submodule pointer is part of the change request.
    await git.raw(['rm', '--cached', '-r', '-f', '--ignore-unmatch', '--', '.worktrees']).catch(() => undefined);
    // This commit is a fallback for whatever the agent left behind, so it is
    // the one place where an unrelated leftover gets published. A binary
    // leftover cannot be merged by anyone, so it is kept out of the commit
    // and reported instead.
    const skippedBinaryFiles = await this.unstageBinaryFiles(git);
    const mergeInProgress = Boolean(await git.raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => ''));
    const staged = (await git.raw(['diff', '--cached', '--name-only']).catch(() => '')).trim();
    if (!staged && !mergeInProgress) return { sha: '', skippedBinaryFiles };
    await git.commit(message);
    return { sha: (await git.revparse(['HEAD'])).trim(), skippedBinaryFiles };
  }

  /**
   * Put the baseline in the worktree and merge the feature branch into it.
   *
   * The merge is left in progress when it conflicts, and the files that
   * still conflict are named. The caller resolves them in this worktree —
   * which is the change request's own branch — so the resolution lands
   * exactly where the change is published from.
   */
  async mergeFeatureIntoBaseline(
    worktreePath: string,
    baselineBranch: string,
    featureBranch: string,
  ): Promise<BaselineMergeResult> {
    const git = simpleGit(worktreePath);
    // Fetch all remote refs before resolving origin/<branch>; a single-branch
    // fetch only guarantees FETCH_HEAD in some Git configurations.
    await git.fetch('origin');
    const baselineRef = `origin/${baselineBranch}`;
    const featureRef = `origin/${featureBranch}`;
    const featureHead = (await this.revParse(git, featureRef)).trim();
    if (!featureHead) throw new Error(`change branch ${featureRef} is not available on the remote`);
    await git.reset(['--hard', baselineRef]);
    // The git client decides that a merge failed by reading an English
    // sentence a localized git never prints, so its exit code says nothing
    // about a conflict. The unmerged paths are what git itself leaves
    // behind, and they are the same in every language.
    await git.raw(['merge', featureRef, '--no-commit', '--no-ff']);
    const conflicts = await this.listUnresolvedConflicts(worktreePath);
    if (conflicts.length > 0) {
      logger.warn({ worktreePath, baselineBranch, featureBranch, conflicts }, 'change branch conflicts with the baseline');
      return { merged: false, conflicts };
    }
    // A merge in progress means the merge landed and is waiting for its
    // commit.
    if ((await this.revParse(git, 'MERGE_HEAD')).trim()) return { merged: true, conflicts: [] };
    // Without one, the change branch carried nothing the baseline does not
    // have already — which is a clean merge, not a failure.
    const mergeBase = (await git.raw(['merge-base', featureRef, baselineRef]).catch(() => '')).trim();
    if (mergeBase && mergeBase === featureHead) return { merged: true, conflicts: [] };
    throw new Error(`merging ${featureRef} into ${baselineRef} failed`);
  }

  async listUnresolvedConflicts(worktreePath: string): Promise<string[]> {
    const git = simpleGit(worktreePath);
    const output = await git.raw(['diff', '--name-only', '--diff-filter=U']).catch(() => '');
    return output.split('\n').map(line => line.trim()).filter(Boolean);
  }

  /** Resolve a revision to its object name; empty when it does not exist. */
  private async revParse(git: SimpleGit, revision: string): Promise<string> {
    return await git.raw(['rev-parse', '--verify', '--quiet', revision]).catch(() => '');
  }

  /**
   * Take the staged binary files back out of the index.
   *
   * The working tree keeps the change, so nothing is lost — it simply does
   * not travel into the change request.
   */
  private async unstageBinaryFiles(git: SimpleGit): Promise<string[]> {
    const binaries = await this.stagedBinaryFiles(git);
    if (binaries.length === 0) return [];
    await git.raw(['restore', '--staged', '--', ...binaries]);
    return binaries;
  }

  /** The staged files git cannot merge as text. */
  private async stagedBinaryFiles(git: SimpleGit): Promise<string[]> {
    const raw = await git.raw(['diff', '--cached', '--numstat', '-z']);
    const tokens = raw.split('\0');
    const binaries: string[] = [];
    let index = 0;
    while (index < tokens.length) {
      const record = tokens[index];
      if (!record) { index += 1; continue; }
      const match = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(record);
      if (!match) { index += 1; continue; }
      const [, added, deleted, path] = match;
      if (path === '') {
        // A rename or copy records two paths: the empty third field is
        // followed by the old and the new path.
        const newPath = tokens[index + 2];
        if (added === '-' && deleted === '-' && newPath) binaries.push(newPath);
        index += 3;
        continue;
      }
      if (added === '-' && deleted === '-') binaries.push(path);
      index += 1;
    }
    return binaries;
  }

  async cleanup(worktreePath: string, options: { preserve?: boolean } = {}): Promise<void> {
    const handle = this.handles.get(worktreePath);
    if (!handle) return;
    // The claim on this path belongs to the attempt that took it, and the
    // attempt ends here. Keeping the worktree is a decision about the files,
    // not about the claim: a claim that outlives its attempt refuses the
    // next attempt of the same item with a double-prepare error instead of
    // the failure that really happened.
    releasePath(worktreePath);
    if (options.preserve) return;
    const config = { type: 'named' as const, branch: handle.branch };
    await strategyForConfig(config).cleanup(simpleGit(this.repoRoot), config, handle, { force: true });
    this.handles.delete(worktreePath);
  }

  private async resolveBaseBranch(branchName: string, fallback: string): Promise<string> {
    const git = simpleGit(this.repoRoot);
    await git.fetch('origin');
    if (await refExists(git, `origin/${branchName}`)) return `origin/${branchName}`;
    if (await refExists(git, `origin/${fallback}`)) return `origin/${fallback}`;
    return fallback;
  }

  private async resolveVerificationBaseBranch(git: ReturnType<typeof simpleGit>, baseBranch: string): Promise<string> {
    await git.fetch('origin');
    if (await refExists(git, `origin/${baseBranch}`)) return `origin/${baseBranch}`;
    return baseBranch;
  }
}

async function refExists(git: ReturnType<typeof simpleGit>, ref: string): Promise<boolean> {
  const remoteRef = ref.startsWith('origin/')
    ? `refs/remotes/${ref}`
    : `refs/heads/${ref}`;
  return (await git.raw(['for-each-ref', '--format=%(refname)', remoteRef])).trim() === remoteRef;
}

/**
 * pnpm keeps its per-workspace task run state inside `node_modules` and
 * refuses to use that directory when it is a symbolic link
 * (ERR_PNPM_UNSAFE_TASK_RUN_STATE_PATH). A worktree therefore receives a real
 * `node_modules` directory whose entries point at the main checkout, instead of
 * one symlink to the main checkout's `node_modules`.
 */
async function shareNodeModules(repoRoot: string, worktreePath: string): Promise<void> {
  const source = join(repoRoot, 'node_modules');
  const target = join(worktreePath, 'node_modules');
  try {
    if (!(await lstat(source)).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    await lstat(target);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const excludePath = resolve(worktreePath, (await simpleGit(worktreePath).raw(['rev-parse', '--git-path', 'info/exclude'])).trim());
  const patterns = await readFile(excludePath, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
  if (!patterns.split(/\r?\n/).includes('/node_modules')) {
    await mkdir(dirname(excludePath), { recursive: true });
    await appendFile(excludePath, '\n/node_modules\n');
  }
  await linkNodeModules(source, target, repoRoot, worktreePath);
}
