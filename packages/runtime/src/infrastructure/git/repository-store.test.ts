import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RepositoryStore } from './repository-store.js';

describe('RepositoryStore', () => {
  let root: string;
  let remote: string;
  let storeRoot: string;
  let store: RepositoryStore;
  const url = 'https://github.com/acme/api.git';

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'afk-repository-store-'));
    remote = join(root, 'remote.git');
    storeRoot = join(root, 'store');
    store = new RepositoryStore(storeRoot);
    const seed = join(root, 'seed');
    await mkdir(seed);
    const git = simpleGit(seed);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'AFK Test');
    await git.addConfig('user.email', 'afk@example.test');
    await writeFile(join(seed, 'tracked.txt'), 'baseline\n');
    await git.add('.');
    await git.commit('baseline');
    await simpleGit().clone(seed, remote, ['--bare']);
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${remote}.insteadOf`);
    vi.stubEnv('GIT_CONFIG_VALUE_0', url);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it('shares one bare repository across concurrent worktrees and reuses it after removal', async () => {
    const first = join(root, 'item-1', 'api');
    const second = join(root, 'item-2', 'api');
    await Promise.all([
      store.ensureCheckout(url, first, 'main'),
      new RepositoryStore(storeRoot).ensureCheckout(url, second, 'main'),
    ]);
    const bare = join(storeRoot, 'github.com', 'acme', 'api', 'bare.git');
    expect((await lstat(join(first, '.git'))).isFile()).toBe(true);
    expect((await lstat(join(second, '.git'))).isFile()).toBe(true);
    for (const checkout of [first, second]) {
      const common = (await simpleGit(checkout).raw(['rev-parse', '--git-common-dir'])).trim();
      expect(await realpath(common)).toBe(await realpath(bare));
      expect(await store.ownsCheckout(checkout)).toBe(true);
    }
    await simpleGit(bare).addConfig('afk.test-cache', 'retained');
    await store.removeCheckout(first);
    await expect(lstat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(second, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    await store.ensureCheckout(url, first, 'main');
    expect((await simpleGit(bare).raw(['config', '--get', 'afk.test-cache'])).trim()).toBe('retained');
    await store.removeCheckout(first);
    await store.removeCheckout(second);
    await store.ensureCheckout('https://github.com/ACME/API.git', first, 'main');
    await store.removeCheckout(first);
    const worktrees = await simpleGit(bare).raw(['worktree', 'list', '--porcelain']);
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1);
  });

  it('refreshes the remote baseline without resetting a checked out local branch', async () => {
    const first = join(root, 'item-1');
    const second = join(root, 'item-2');
    await store.ensureCheckout(url, first, 'main');
    const git = simpleGit(first);
    await git.checkout('main');
    const original = (await git.revparse(['HEAD'])).trim();
    const seed = simpleGit(join(root, 'seed'));
    await writeFile(join(root, 'seed', 'tracked.txt'), 'updated\n');
    await seed.add('.');
    await seed.commit('updated baseline');
    await seed.push(remote, 'main');

    await store.ensureCheckout(url, second, 'main');

    expect((await git.revparse(['HEAD'])).trim()).toBe(original);
    expect(await readFile(join(first, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    expect(await readFile(join(second, 'tracked.txt'), 'utf8')).toBe('updated\n');
  });

  it('removes nested QA worktree registrations and reports a locked checkout without deleting it', async () => {
    const checkout = join(root, 'item-1');
    await store.ensureCheckout(url, checkout, 'main');
    const git = simpleGit(checkout);
    const qa = join(checkout, '.worktrees', 'qa');
    await git.raw(['worktree', 'add', '--detach', qa, 'HEAD']);
    await git.raw(['worktree', 'lock', qa]);

    await expect(store.removeCheckout(checkout)).rejects.toThrow();
    expect(await readFile(join(qa, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    await git.raw(['worktree', 'unlock', qa]);
    await store.removeCheckout(checkout);
    const bare = join(storeRoot, 'github.com', 'acme', 'api', 'bare.git');
    expect((await simpleGit(bare).raw(['worktree', 'list', '--porcelain'])).match(/^worktree /gm)).toHaveLength(1);
  });

  it.each(['tracked', 'untracked', 'ignored'])('safe removal retains %s files and preserves existing forced-removal behavior', async kind => {
    const checkout = join(root, 'item-1');
    await store.ensureCheckout(url, checkout, 'main');
    const path = join(checkout, kind === 'tracked' ? 'tracked.txt' : kind === 'ignored' ? '.env' : 'notes.txt');
    if (kind === 'ignored') {
      const exclude = (await simpleGit(checkout).raw(['rev-parse', '--git-path', 'info/exclude'])).trim();
      await writeFile(exclude, '.env\n');
    }
    await writeFile(path, 'local content');
    await expect(store.removeCheckout(checkout, { force: false })).rejects.toThrow('content');
    expect(await readFile(path, 'utf8')).toBe('local content');
    await store.removeCheckout(checkout);
    await expect(lstat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('safe removal retains nested worktrees instead of recursively forcing their removal', async () => {
    const checkout = join(root, 'item-1');
    await store.ensureCheckout(url, checkout, 'main');
    const verification = join(checkout, 'verification');
    await simpleGit(checkout).raw(['worktree', 'add', '--detach', verification, 'HEAD']);
    await expect(store.removeCheckout(checkout, { force: false })).rejects.toThrow('nested worktree');
    expect(await readFile(join(verification, 'tracked.txt'), 'utf8')).toBe('baseline\n');
  });

  it('runs the safe validation hook before removal and preserves files when it rejects', async () => {
    const checkout = join(root, 'item-1');
    await store.ensureCheckout(url, checkout, 'main');
    const beforeRemove = vi.fn(async () => { throw new Error('validation refused'); });
    await expect(store.removeCheckout(checkout, { force: false, beforeRemove })).rejects.toThrow('validation refused');
    expect(beforeRemove).toHaveBeenCalledOnce();
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    await store.removeCheckout(checkout, { force: false });
    await expect(lstat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('discards failed clone staging and can retry using the same repository identity', async () => {
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${join(root, 'missing.git')}.insteadOf`);
    await expect(store.ensureCheckout(url, join(root, 'item-1'), 'main')).rejects.toThrow();
    expect(await readdir(join(storeRoot, 'github.com', 'acme', 'api'))).toEqual([]);
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${remote}.insteadOf`);
    await store.ensureCheckout(url, join(root, 'item-1'), 'main');
    expect(await store.ownsCheckout(join(root, 'item-1'))).toBe(true);
  });

  it('rejects a symlink in the cache path and refuses to delete an independent repository', async () => {
    await mkdir(storeRoot);
    const external = join(root, 'external');
    await mkdir(external);
    await symlink(external, join(storeRoot, 'github.com'), 'dir');
    await expect(store.ensureCheckout(url, join(root, 'item-1'), 'main')).rejects.toThrow('non-symlink');
    expect(await readdir(external)).toEqual([]);
    await expect(store.removeCheckout(join(root, 'seed'))).rejects.toThrow('outside the repository store');
    expect(await readFile(join(root, 'seed', 'tracked.txt'), 'utf8')).toBe('baseline\n');
  });

  it('refuses a cache whose origin was changed', async () => {
    const checkout = join(root, 'item-1');
    await store.ensureCheckout(url, checkout, 'main');
    await simpleGit(checkout).remote(['set-url', 'origin', 'https://github.com/other/api.git']);
    await expect(store.ensureCheckout(url, join(root, 'item-2'), 'main')).rejects.toThrow('origin does not match');
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n');
  });

  it('cuts a PRD baseline branch from the remote default branch and refuses to invent any other', async () => {
    const baseline = join(root, 'item-1', 'api');
    await store.ensureCheckout(url, baseline, 'prd/27', { createBaseline: true });
    const bare = join(storeRoot, 'github.com', 'acme', 'api', 'bare.git');
    expect((await simpleGit(bare).raw(['branch', '-r', '--list', 'origin/prd/27'])).trim()).toContain('origin/prd/27');
    expect(await readFile(join(baseline, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    expect((await simpleGit(remote).raw(['branch', '--list', 'prd/27'])).trim()).toContain('prd/27');

    await expect(store.ensureCheckout(url, join(root, 'item-2', 'api'), 'release'))
      .rejects.toThrow('base branch release does not exist');
  });
});
