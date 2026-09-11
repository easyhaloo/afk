import { simpleGit } from 'simple-git';
import type { BacklogItem } from '../backlog';
import type { BranchProvider, BranchHandle } from './provider';
import { strategyForConfig } from '../../branches/registry';
import type { BranchHandle as StrategyHandle } from '../../branches/types';

export class GitBranchProvider implements BranchProvider {
  private readonly handles = new Map<string, StrategyHandle>();

  constructor(private readonly repoRoot: string) {}

  async createBranch(item: BacklogItem, baseBranch: string): Promise<BranchHandle> {
    const config = { type: 'named' as const, branch: item.branchName, baseBranch };
    const strategy = strategyForConfig(config);
    const handle = await strategy.prepareWorktree(simpleGit(this.repoRoot), config, { repoPath: this.repoRoot, baseBranch });
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
    await simpleGit(worktreePath).push('origin', branchName);
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
}
