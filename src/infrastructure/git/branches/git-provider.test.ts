import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { GitBranchProvider } from './git-provider';
import type { BacklogItem } from '../../../domain/backlog/index';
import { _clearPreparedWorktreesForTest } from '../../../domain/branches/base';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

beforeEach(() => _clearPreparedWorktreesForTest());

async function repository(): Promise<{ repoPath: string; remotePath: string }> {
  const repoPath = await mkdtemp(join(tmpdir(), 'afk-git-provider-'));
  const remotePath = await mkdtemp(join(tmpdir(), 'afk-git-provider-remote-'));
  cleanupPaths.push(repoPath, remotePath);

  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await writeFile(join(repoPath, 'README.md'), 'base\n');
  await git.add('README.md');
  await git.commit('base');
  await git.raw(['branch', '-M', 'main']);

  await simpleGit(remotePath).init(true);
  await git.addRemote('origin', remotePath);
  await git.push('origin', 'main');
  return { repoPath, remotePath };
}

function item(): BacklogItem {
  return {
    id: '42',
    title: 'Remote-backed backlog',
    dependsOn: [],
    state: 'in_progress',
    executionMode: 'afk',
    tags: [],
    branchName: 'afk/backlog-42',
    providerRef: 'github:org/repo#42',
  };
}

describe('GitBranchProvider', () => {
  it('creates a backlog worktree from the latest remote backlog branch', async () => {
    const { repoPath, remotePath } = await repository();
    const publisherPath = await mkdtemp(join(tmpdir(), 'afk-git-provider-publisher-'));
    cleanupPaths.push(publisherPath);
    const publisher = simpleGit(publisherPath);
    await publisher.clone(remotePath, publisherPath);
    await publisher.addConfig('user.email', 'test@example.com');
    await publisher.addConfig('user.name', 'Test');
    await publisher.checkoutLocalBranch('afk/backlog-42', 'origin/main');
    await writeFile(join(publisherPath, 'child-result.txt'), 'merged child result\n');
    await publisher.add('child-result.txt');
    const { commit } = await publisher.commit('child result');
    await publisher.push('origin', 'afk/backlog-42');

    const provider = new GitBranchProvider(repoPath);
    const handle = await provider.createBranch(item(), 'main');
    const worktreeGit = simpleGit(handle.worktreePath);

    await expect(worktreeGit.revparse(['HEAD'])).resolves.toContain(commit);
    await expect(worktreeGit.raw(['show', 'HEAD:child-result.txt'])).resolves.toContain('merged child result');
  });

  it('reuses an existing local backlog branch after a prior interrupted run', async () => {
    const { repoPath } = await repository();
    const git = simpleGit(repoPath);
    await git.checkoutLocalBranch('afk/backlog-42', 'main');
    await writeFile(join(repoPath, 'interrupted-work.txt'), 'preserve this work\n');
    await git.add('interrupted-work.txt');
    await git.commit('interrupted work');
    await git.checkout('main');

    const provider = new GitBranchProvider(repoPath);
    const handle = await provider.createBranch(item(), 'main');
    const worktreeGit = simpleGit(handle.worktreePath);

    expect(handle.branchName).toBe('afk/backlog-42');
    await expect(worktreeGit.raw(['show', 'HEAD:interrupted-work.txt'])).resolves.toContain('preserve this work');
  });

  it('integrates remote child results that arrive before the parent branch is pushed', async () => {
    const { repoPath, remotePath } = await repository();
    const publisherPath = await mkdtemp(join(tmpdir(), 'afk-git-provider-publisher-'));
    cleanupPaths.push(publisherPath);
    const publisher = simpleGit(publisherPath);
    await publisher.clone(remotePath, publisherPath);
    await publisher.addConfig('user.email', 'test@example.com');
    await publisher.addConfig('user.name', 'Test');
    await publisher.checkoutLocalBranch('afk/backlog-42', 'origin/main');
    await writeFile(join(publisherPath, 'first-child.txt'), 'first child\n');
    await publisher.add('first-child.txt');
    await publisher.commit('first child');
    await publisher.push('origin', 'afk/backlog-42');

    const provider = new GitBranchProvider(repoPath);
    const handle = await provider.createBranch(item(), 'main');
    const worktreeGit = simpleGit(handle.worktreePath);
    await worktreeGit.addConfig('user.email', 'test@example.com');
    await worktreeGit.addConfig('user.name', 'Test');
    await writeFile(join(handle.worktreePath, 'parent-work.txt'), 'parent work\n');
    await worktreeGit.add('parent-work.txt');
    await worktreeGit.commit('parent work');

    await writeFile(join(publisherPath, 'second-child.txt'), 'second child\n');
    await publisher.add('second-child.txt');
    await publisher.commit('second child');
    await publisher.push('origin', 'afk/backlog-42');

    await provider.push(handle.branchName, handle.worktreePath);
    const remote = simpleGit(remotePath);

    await expect(remote.raw(['show', 'afk/backlog-42:parent-work.txt'])).resolves.toContain('parent work');
    await expect(remote.raw(['show', 'afk/backlog-42:second-child.txt'])).resolves.toContain('second child');
  });

  it('creates QA worktrees from a remote-only parent branch', async () => {
    const { repoPath, remotePath } = await repository();
    const publisherPath = await mkdtemp(join(tmpdir(), 'afk-git-provider-publisher-'));
    cleanupPaths.push(publisherPath);
    const publisher = simpleGit(publisherPath);
    await publisher.clone(remotePath, publisherPath);
    await publisher.addConfig('user.email', 'test@example.com');
    await publisher.addConfig('user.name', 'Test');
    await publisher.checkoutLocalBranch('afk/backlog-42', 'origin/main');
    await writeFile(join(publisherPath, 'parent-result.txt'), 'parent baseline\n');
    await publisher.add('parent-result.txt');
    await publisher.commit('parent baseline');
    await publisher.push('origin', 'afk/backlog-42');

    const provider = new GitBranchProvider(repoPath);
    const child: BacklogItem = { ...item(), id: '43', branchName: 'afk/backlog-43' };
    const handle = await provider.createVerificationWorktree(child, 'afk/backlog-42');

    expect(handle.branchName).toBe('afk/backlog-43-qa');
    await expect(simpleGit(handle.worktreePath).raw(['show', 'HEAD:parent-result.txt'])).resolves.toContain('parent baseline');
  });
});
