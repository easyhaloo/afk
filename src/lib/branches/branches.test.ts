import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { promises as afs } from 'fs';
import { simpleGit, type SimpleGit } from 'simple-git';
import { IssueBranchStrategy } from './issue';
import { NamedBranchStrategy } from './named';
import { MergeToHeadBranchStrategy } from './merge-to-head';
import { ExistingBranchStrategy } from './existing';
import {
  getBranchStrategy,
  requireBranchStrategy,
  strategyForConfig,
  listBranchStrategies,
  registerBranchStrategy,
  _resetBranchStrategyRegistry,
} from './registry';
import { _clearPreparedWorktreesForTest } from './base';
import type { BranchStrategyConfig } from './types';

/** Create a temp git repo with an initial commit on main. Returns repoPath + git handle. */
async function makeRepo(): Promise<{ repoPath: string; git: SimpleGit }> {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'afk-branch-fixture-'));
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await git.addConfig('commit.gpgsign', 'false');
  // Initial commit on main (or master, depending on git's defaultBranch setting).
  await fs.writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  await git.add('README.md');
  await git.commit('initial commit');
  // Rename to main for predictable baseBranch in tests.
  try { await git.raw(['branch', '-M', 'main']); } catch { /* already main */ }
  return { repoPath, git };
}

describe('BranchStrategy — registry', () => {
  beforeEach(() => _resetBranchStrategyRegistry());
  afterEach(() => _resetBranchStrategyRegistry());

  it('listBranchStrategies returns all four kinds', () => {
    const kinds = listBranchStrategies();
    expect(kinds).toEqual(expect.arrayContaining(['issue', 'named', 'merge-to-head', 'existing']));
  });

  it('strategyForConfig picks the strategy matching config.type', () => {
    expect(strategyForConfig({ type: 'issue', iid: 1 })).toBeInstanceOf(IssueBranchStrategy);
    expect(strategyForConfig({ type: 'named', branch: 'foo' })).toBeInstanceOf(NamedBranchStrategy);
    expect(strategyForConfig({ type: 'merge-to-head' })).toBeInstanceOf(MergeToHeadBranchStrategy);
    expect(strategyForConfig({ type: 'existing', branch: 'main' })).toBeInstanceOf(ExistingBranchStrategy);
  });

  it('requireBranchStrategy throws for unknown kind', () => {
    // Force an unknown kind by reaching for it directly.
    expect(() => requireBranchStrategy('issue')).not.toThrow();
    // @ts-expect-error: invalid kind
    expect(() => requireBranchStrategy('bogus')).toThrow(/not registered/);
  });

  it('registerBranchStrategy overwrites existing', () => {
    const custom = new IssueBranchStrategy();
    registerBranchStrategy(custom);
    expect(getBranchStrategy('issue')).toBe(custom);
  });
});

describe('IssueBranchStrategy', () => {
  let repoPath: string;
  let git: SimpleGit;

  beforeEach(async () => {
    _clearPreparedWorktreesForTest();
    ({ repoPath, git } = await makeRepo());
  });
  afterEach(async () => {
    await afs.rm(repoPath, { recursive: true, force: true });
  });

  it('resolveBranch returns afk-issue-<iid>', () => {
    const s = new IssueBranchStrategy();
    expect(s.resolveBranch({ type: 'issue', iid: 42 })).toBe('afk-issue-42');
  });

  it('prepareWorktree creates a new branch + worktree', async () => {
    const s = new IssueBranchStrategy();
    const handle = await s.prepareWorktree(git, { type: 'issue', iid: 42 }, { repoPath });
    expect(handle.branch).toBe('afk-issue-42');
    expect(handle.path).toMatch(/issue-42$/);
    expect(handle.isNewBranch).toBe(true);
    expect(fs.existsSync(path.join(handle.path, 'README.md'))).toBe(true);
  });

  it('cleanup removes worktree + branch', async () => {
    const s = new IssueBranchStrategy();
    const handle = await s.prepareWorktree(git, { type: 'issue', iid: 42 }, { repoPath });
    await s.cleanup(git, { type: 'issue', iid: 42 }, handle);
    expect(fs.existsSync(handle.path)).toBe(false);
    const branches = (await git.raw(['branch', '--list', 'afk-issue-42'])).trim();
    expect(branches).toBe('');
  });
});

describe('NamedBranchStrategy', () => {
  let repoPath: string;
  let git: SimpleGit;

  beforeEach(async () => {
    ({ repoPath, git } = await makeRepo());
  });
  afterEach(async () => {
    await afs.rm(repoPath, { recursive: true, force: true });
  });

  it('rejects reserved prefixes', () => {
    const s = new NamedBranchStrategy();
    expect(() => s.resolveBranch({ type: 'named', branch: 'HEAD' })).not.toThrow();
    // validation runs at prepareWorktree:
    return s.prepareWorktree(git, { type: 'named', branch: 'HEAD' }, { repoPath })
      .then(() => { throw new Error('should have thrown'); })
      .catch((err: Error) => expect(err.message).toMatch(/reserved prefix/));
  });

  it('rejects branch names with git-illegal characters', async () => {
    const s = new NamedBranchStrategy();
    await expect(s.prepareWorktree(git, { type: 'named', branch: 'foo..bar' }, { repoPath }))
      .rejects.toThrow(/invalid branch/);
  });

  it('prepareWorktree creates branch + worktree with sanitized dir name', async () => {
    const s = new NamedBranchStrategy();
    const handle = await s.prepareWorktree(git, { type: 'named', branch: 'feature/login' }, { repoPath });
    expect(handle.branch).toBe('feature/login');
    // '/' in branch becomes '-' in directory name.
    expect(handle.path).toMatch(/feature-login$/);
  });
});

describe('MergeToHeadBranchStrategy', () => {
  let repoPath: string;
  let git: SimpleGit;

  beforeEach(async () => {
    ({ repoPath, git } = await makeRepo());
  });
  afterEach(async () => {
    await afs.rm(repoPath, { recursive: true, force: true });
  });

  it('prepareWorktree creates a unique afk-merge-<short> branch', async () => {
    const s = new MergeToHeadBranchStrategy();
    const handle = await s.prepareWorktree(git, { type: 'merge-to-head' }, { repoPath });
    expect(handle.branch).toMatch(/^afk-merge-[a-f0-9]{8}$/);
    expect(handle.isNewBranch).toBe(true);
  });

  it('finalize merges the scratch branch back to HEAD', async () => {
    const s = new MergeToHeadBranchStrategy();
    const handle = await s.prepareWorktree(git, { type: 'merge-to-head' }, { repoPath });

    // Make a commit on the scratch branch.
    await fs.writeFileSync(path.join(handle.path, 'change.txt'), 'agent edit\n');
    const wtGit = simpleGit(handle.path);
    await wtGit.add('change.txt');
    await wtGit.commit('agent: edit');

    await s.finalize(git, { type: 'merge-to-head' }, handle);

    // HEAD should now contain the new file (via merge commit).
    const headReadme = (await git.raw(['show', 'HEAD:change.txt'])).trim();
    expect(headReadme).toBe('agent edit');
  });

  it('cleanup always deletes the scratch branch', async () => {
    const s = new MergeToHeadBranchStrategy();
    const handle = await s.prepareWorktree(git, { type: 'merge-to-head' }, { repoPath });
    await s.cleanup(git, { type: 'merge-to-head' }, handle);
    const branches = (await git.raw(['branch', '--list', handle.branch])).trim();
    expect(branches).toBe('');
  });
});

describe('ExistingBranchStrategy', () => {
  let repoPath: string;
  let git: SimpleGit;

  beforeEach(async () => {
    ({ repoPath, git } = await makeRepo());
    // Pre-create a branch to reuse.
    await git.raw(['checkout', '-b', 'preexisting']);
    await git.raw(['checkout', 'main']);
  });
  afterEach(async () => {
    await afs.rm(repoPath, { recursive: true, force: true });
  });

  it('refuses to attach when the branch is checked out in another worktree', async () => {
    // Attach the branch to a temp worktree first.
    const otherPath = path.join(repoPath, '.worktrees', 'preexisting');
    await afs.mkdir(path.dirname(otherPath), { recursive: true });
    await git.raw(['worktree', 'add', otherPath, 'preexisting']);

    const s = new ExistingBranchStrategy();
    await expect(s.prepareWorktree(git, { type: 'existing', branch: 'preexisting' }, { repoPath }))
      .rejects.toThrow(/already checked out/);
  });

  it('refuses when the branch does not exist', async () => {
    const s = new ExistingBranchStrategy();
    await expect(s.prepareWorktree(git, { type: 'existing', branch: 'ghost' }, { repoPath }))
      .rejects.toThrow(/does not exist/);
  });

  it('attaches a new worktree to an existing branch when no path given', async () => {
    const s = new ExistingBranchStrategy();
    const handle = await s.prepareWorktree(git, { type: 'existing', branch: 'preexisting' }, { repoPath });
    expect(handle.isNewBranch).toBe(false);
    expect(handle.branch).toBe('preexisting');
    expect(fs.existsSync(handle.path)).toBe(true);
  });
});

describe('BranchStrategy — parallel-worktree isolation', () => {
  let repoPath: string;
  let git: SimpleGit;

  beforeEach(async () => {
    ({ repoPath, git } = await makeRepo());
  });
  afterEach(async () => {
    await afs.rm(repoPath, { recursive: true, force: true });
  });

  it('refuses to share a writable branch between two prepareWorktree calls', async () => {
    const s = new IssueBranchStrategy();
    const h1 = await s.prepareWorktree(git, { type: 'issue', iid: 1 }, { repoPath });
    // Second call for iid=1 must reuse OR refuse — the same branch cannot be
    // checked out in two worktrees simultaneously.
    await expect(s.prepareWorktree(git, { type: 'issue', iid: 1 }, { repoPath }))
      .rejects.toThrow(/already prepared/);
    // But a different issue IID uses a different branch + path, so it works.
    const h2 = await s.prepareWorktree(git, { type: 'issue', iid: 2 }, { repoPath });
    expect(h2.branch).toBe('afk-issue-2');
    expect(h2.path).not.toBe(h1.path);
  });

  it('refuses two strategies trying to use the same branch name', async () => {
    // Force the collision by reusing a path for two different strategies.
    // The named strategy with branch 'foo' should conflict with issue if
    // the worktree path collides — but since each uses a different path
    // scheme, the conflict only arises when the path is forced equal.
    // Here we test the simpler case: NamedBranchStrategy twice for the same
    // branch fails the second time.
    const s = new NamedBranchStrategy();
    const h1 = await s.prepareWorktree(git, { type: 'named', branch: 'foo' }, { repoPath });
    await expect(s.prepareWorktree(git, { type: 'named', branch: 'foo' }, { repoPath }))
      .rejects.toThrow(/already prepared/);
  });
});