import { appendFile, lstat, mkdir, readFile, symlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { simpleGit } from 'simple-git';
import type { BacklogItem } from '@afk/application';
import type { BranchProvider, ProviderBranchHandle } from './provider.js';
import { strategyForConfig } from '../../branches/registry.js';
import type { BranchHandle as StrategyHandle } from '../../branches/types.js';
import { excludeAfkArtefacts } from '../repo-exclude.js';
import { logger } from '../../io/index.js';

export class GitBranchProvider implements BranchProvider {
  private readonly handles = new Map<string, StrategyHandle>();

  constructor(private readonly repoRoot: string) {}

  async createBranch(item: BacklogItem, baseBranch: string): Promise<ProviderBranchHandle> {
    await this.protectRepo();
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

  async createVerificationWorktree(item: BacklogItem, baseBranch: string): Promise<ProviderBranchHandle> {
    await this.protectRepo();
    const git = simpleGit(this.repoRoot);
    const verificationBase = await this.resolveVerificationBaseBranch(git, baseBranch);
    const config = { type: 'named' as const, branch: `${item.branchName}-qa`, baseBranch: verificationBase };
    const strategy = strategyForConfig(config);
    const handle = await strategy.prepareWorktree(git, config, { repoPath: this.repoRoot, baseBranch: verificationBase });
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
        if (await isAncestor(git, localHead, remoteHead)) {
          await git.merge(['--ff-only', remoteBranch]);
        } else if (!(await isAncestor(git, remoteHead, localHead))) {
          await git.merge([remoteBranch, '--no-edit']);
        }
      }
    }
    await git.push('origin', branchName);
  }

  async commit(worktreePath: string, message: string): Promise<string> {
    const git = simpleGit(worktreePath);
    await git.add(['-A']);
    if ((await git.status()).isClean() && !(await git.raw(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD']).catch(() => ''))) return '';
    await git.commit(message);
    return (await git.revparse(['HEAD'])).trim();
  }

  async cleanup(worktreePath: string, options: { preserve?: boolean } = {}): Promise<void> {
    const handle = this.handles.get(worktreePath);
    if (!handle || options.preserve) return;
    const config = { type: 'named' as const, branch: handle.branch };
    await strategyForConfig(config).cleanup(simpleGit(this.repoRoot), config, handle, { force: true });
    this.handles.delete(worktreePath);
  }

  /**
   * Keep AFK's own files out of the repository's commits.
   *
   * AFK writes its working files into the repository it works in, and
   * `git add -A` - which this provider runs itself when it commits the
   * agent's work - would put them in the user's branch and in the change
   * request. The exclusion is written once per repository and covers the
   * main checkout and the worktrees alike.
   */
  private async protectRepo(): Promise<void> {
    await excludeAfkArtefacts(this.repoRoot).catch(error =>
      logger.warn({ repoRoot: this.repoRoot, err: error }, 'could not keep AFK artefacts out of the repository commits'),
    );
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

async function isAncestor(git: ReturnType<typeof simpleGit>, ancestor: string, descendant: string): Promise<boolean> {
  return (await git.raw(['merge-base', ancestor, descendant])).trim() === ancestor;
}

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
  await symlink(source, target, 'dir');
}
