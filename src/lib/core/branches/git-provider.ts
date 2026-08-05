import { simpleGit } from 'simple-git';
import type { BacklogItem } from '../backlog';
import type { BranchProvider, BranchHandle } from './provider';
import { strategyForConfig } from '../../branches/registry';
import type { BranchHandle as StrategyHandle } from '../../branches/types';

export class GitBranchProvider implements BranchProvider {
  private readonly handles = new Map<string, StrategyHandle>();

  constructor(private readonly repoRoot: string) {}

  async createBranch(item: BacklogItem, baseBranch: string): Promise<BranchHandle> {
    const config = {
      type: 'named' as const,
      branch: item.branchName,
      baseBranch: await this.resolveBaseBranch(item.branchName, baseBranch),
    };
    const strategy = strategyForConfig(config);
    const handle = await strategy.prepareWorktree(simpleGit(this.repoRoot), config, { repoPath: this.repoRoot, baseBranch: config.baseBranch });
    this.handles.set(handle.path, handle);
    return { branchName: handle.branch, worktreePath: handle.path };
  }

  async createVerificationWorktree(item: BacklogItem, baseBranch: string): Promise<BranchHandle> {
    const config = { type: 'named' as const, branch: `${item.branchName}-qa`, baseBranch };
    const strategy = strategyForConfig(config);
    const handle = await strategy.prepareWorktree(simpleGit(this.repoRoot), config, { repoPath: this.repoRoot, baseBranch });
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
    const result = await git.commit(message);
    return result.commit;
  }

  async cleanup(worktreePath: string, options: { preserve?: boolean } = {}): Promise<void> {
    const handle = this.handles.get(worktreePath);
    if (!handle || options.preserve) return;
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
