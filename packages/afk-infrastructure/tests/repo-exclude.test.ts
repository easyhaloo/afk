import { describe, expect, it, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { simpleGit } from 'simple-git';
import { excludeAfkArtefacts } from '../src/git/repo-exclude.js';
import { defaultWorktreeBaseDir } from '../src/branches/base.js';

const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function repository(): Promise<string> {
  const repoPath = await mkdtemp(join(tmpdir(), 'afk-repo-exclude-'));
  cleanupPaths.push(repoPath);
  const git = simpleGit(repoPath);
  await git.init();
  await git.addConfig('user.email', 'test@example.com');
  await git.addConfig('user.name', 'Test');
  await writeFile(join(repoPath, 'README.md'), 'base\n');
  await git.add('README.md');
  await git.commit('base');
  return repoPath;
}

async function withWorktree(repoPath: string): Promise<string> {
  const worktreePath = join(repoPath, '.worktrees', 'issue-1');
  await simpleGit(repoPath).raw(['worktree', 'add', '-b', 'afk-issue-1', worktreePath]);
  return worktreePath;
}

describe('excludeAfkArtefacts', () => {
  it('keeps AFK\'s own files out of a commit made in the worktree', async () => {
    const repoPath = await repository();
    const worktreePath = await withWorktree(repoPath);

    await excludeAfkArtefacts(repoPath);

    await writeFile(join(worktreePath, '.afk-signal.json'), '{"type":"goal_complete"}\n');
    await mkdir(join(worktreePath, '.afk', 'handoff'), { recursive: true });
    await writeFile(join(worktreePath, '.afk', 'handoff', 'handoff-42-1.md'), 'handoff\n');
    await mkdir(join(worktreePath, '.claude'), { recursive: true });
    await writeFile(join(worktreePath, '.claude', 'settings.local.json'), '{}\n');

    const worktreeGit = simpleGit(worktreePath);
    await worktreeGit.add(['-A']);
    expect((await worktreeGit.status()).files).toEqual([]);
  });

  it('keeps the worktree out of a commit made in the main checkout', async () => {
    const repoPath = await repository();
    await withWorktree(repoPath);

    await excludeAfkArtefacts(repoPath);

    const git = simpleGit(repoPath);
    await git.add(['-A']);
    // Without the exclusion the worktree is added as an embedded
    // repository - a gitlink nobody else can fetch.
    expect((await git.status()).files).toEqual([]);
  });

  it('leaves a directory that is not a repository alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afk-repo-exclude-plain-'));
    cleanupPaths.push(dir);

    await expect(excludeAfkArtefacts(dir)).resolves.toBeUndefined();
  });

  it('adds the patterns once', async () => {
    const repoPath = await repository();

    await excludeAfkArtefacts(repoPath);
    await excludeAfkArtefacts(repoPath);

    const excludePath = resolve(repoPath, (await simpleGit(repoPath).raw(['rev-parse', '--git-path', 'info/exclude'])).trim());
    const contents = await readFile(excludePath, 'utf8');
    expect(contents.split(/\r?\n/).filter(line => line.trim() === '/.afk/')).toHaveLength(1);
  });

  it('excludes the directory the worktrees actually go into', async () => {
    const repoPath = await repository();

    await excludeAfkArtefacts(repoPath);

    const excludePath = resolve(repoPath, (await simpleGit(repoPath).raw(['rev-parse', '--git-path', 'info/exclude'])).trim());
    const contents = await readFile(excludePath, 'utf8');
    // The worktrees live in one place and the exclusion has to name that
    // place: move the worktrees and this test says so.
    const expected = `/${relative(repoPath, defaultWorktreeBaseDir(repoPath)).split(sep).join('/')}/`;
    expect(contents.split(/\r?\n/).map(line => line.trim())).toContain(expected);
  });
});
