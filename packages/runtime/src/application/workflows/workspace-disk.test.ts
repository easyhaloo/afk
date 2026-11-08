import { cp, lstat, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { simpleGit } from 'simple-git';
import { RepositoryLeases } from '../../infrastructure/git/repository-lease.js';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';
import { RepositoryStore } from '../../infrastructure/git/repository-store.js';
import { executionWorkspacePath, workspaceDataDirectory, workspaceStateDirectory } from '../../infrastructure/workspace.js';
import { inspectWorkspaceDisk } from './workspace-disk.js';

describe('workspace disk inventory and targeted cleanup', () => {
  let temporary: string;
  let root: string;
  let workspace: string;
  let checkout: string;
  let bare: string;
  let manifestPath: string;
  let journal: string;
  let leases: RepositoryLeases;
  const workItemId = 'github:doctor-test/api#913';
  const key = 'github:doctor-test/api';
  const manifest = () => ({ schemaVersion: 1, workItemId, providerBacklogId: '913',
    tracker: { platform: 'github', projectKey: 'doctor-test/api' }, workingBranch: 'afk/913', repositories: [{
      platform: 'github', projectKey: 'doctor-test/api', name: 'api', checkoutPath: 'repositories/api',
      baseBranch: 'main', workingBranch: 'afk/913', primary: true,
    }] });
  const inspect = (cleanup?: string) => inspectWorkspaceDisk({ root, manifests: [manifestPath], leases, cleanup });
  const phase = (value: string) => writeFile(journal, JSON.stringify({ phase: value, at: '2026-11-04T12:00:00Z' }) + '\n');
  const retained = async (reason?: string) => {
    const report = await inspect(workItemId);
    expect(report.cleanup).toMatchObject({ status: 'retained', bytes: 0 });
    if (reason) expect(report.cleanup?.reason).toContain(reason);
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    return report;
  };

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), 'afk-doctor-'));
    root = join(temporary, 'cache');
    workspace = executionWorkspacePath(workItemId, root);
    checkout = join(workspace, 'repositories/api');
    bare = join(root, 'repos/github.com/doctor-test/api/bare.git');
    manifestPath = join(temporary, 'execution-manifest.json');
    journal = join(workspaceDataDirectory(workspace), 'executions/attempt.jsonl');
    leases = new RepositoryLeases(join(temporary, 'leases'));
    const seed = join(temporary, 'source');
    await mkdir(seed);
    const git = simpleGit(seed);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.name', 'AFK Test');
    await git.addConfig('user.email', 'afk@example.test');
    await writeFile(join(seed, 'tracked.txt'), 'baseline\n');
    await writeFile(join(seed, '.gitignore'), 'node_modules/\n.verification/\n.env\nlocal.config\nprivate/\n');
    await git.add('.');
    await git.commit('baseline');
    await mkdir(dirname(bare), { recursive: true });
    await simpleGit().clone(seed, bare, ['--bare']);
    await simpleGit(bare).raw(['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    await mkdir(dirname(checkout), { recursive: true });
    await simpleGit(bare).raw(['worktree', 'add', '--detach', checkout, 'HEAD']);
    await writeFile(manifestPath, JSON.stringify(manifest()));
    await mkdir(dirname(journal), { recursive: true });
    await phase('done');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(temporary, { recursive: true, force: true });
    await rm(workspaceDataDirectory(workspace), { recursive: true, force: true });
    await rm(join(workspaceStateDirectory(), 'runtime'), { recursive: true, force: true });
  });

  it.each([undefined, 0])('inspects a legacy manifest (version %s) without execution validation, mutation, or reclamation', async schemaVersion => {
    const legacy = { schemaVersion, workItemId, workspaceRoot: workspace, repositories: [{ checkoutPath: '../old-layout' }] };
    const original = JSON.stringify(legacy);
    await writeFile(manifestPath, original);
    const report = await inspect();
    expect(report.workspaces).toHaveLength(1);
    expect(report.workspaces[0]).toMatchObject({ workItemId, state: 'legacy', active: null, reclaimableBytes: 0 });
    expect(report.workspaces[0].bytes).toBeGreaterThan(0);
    expect(report.diagnostics).toEqual([]);
    expect(await readFile(manifestPath, 'utf8')).toBe(original);
    await retained('read-only');
  });

  it('inspects without acquiring leases or writing cache state', async () => {
    const report = await inspect();
    expect(report.repositories[0]).toMatchObject({ path: bare, checkouts: 1 });
    expect(report.workspaces[0]).toMatchObject({ workItemId, active: false, state: 'done' });
    expect(report.workspaces[0].reclaimableBytes).toBe(report.workspaces[0].bytes);
    expect(report.diagnostics).toEqual([]);
    await expect(lstat(join(temporary, 'leases'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each(['done', 'merge_ready'])('removes only the targeted clean generated %s workspace, retaining source, bare cache, and evidence', async state => {
    await phase(state);
    const sibling = join(root, 'unrelated/source.txt');
    await mkdir(dirname(sibling), { recursive: true });
    await writeFile(sibling, 'keep');
    const report = await inspect(workItemId);
    expect(report.cleanup).toMatchObject({ target: workItemId, path: workspace, status: 'removed' });
    expect(report.cleanup!.bytes).toBeGreaterThan(0);
    expect(report.diagnostics).toEqual([]);
    await expect(lstat(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(temporary, 'source/tracked.txt'), 'utf8')).toBe('baseline\n');
    expect(await readFile(sibling, 'utf8')).toBe('keep');
    expect(await readFile(journal, 'utf8')).toContain(state);
    expect(await readFile(manifestPath, 'utf8')).toContain(workItemId);
    expect(await simpleGit(bare).raw(['worktree', 'list', '--porcelain'])).not.toContain(checkout);
  });

  it('accepts an exact reported absolute workspace path', async () => {
    expect((await inspect(workspace)).cleanup?.status).toBe('removed');
  });

  it('reports partial cleanup honestly if a later checkout cannot be removed', async () => {
    const second = join(workspace, 'repositories/web');
    await simpleGit(bare).raw(['worktree', 'add', '--detach', second, 'HEAD']);
    const value = manifest();
    value.repositories.push({ ...value.repositories[0], name: 'web', projectKey: 'doctor-test/web', checkoutPath: 'repositories/web', primary: false });
    await writeFile(manifestPath, JSON.stringify(value));
    const remove = RepositoryStore.prototype.removeCheckout;
    vi.spyOn(RepositoryStore.prototype, 'removeCheckout').mockImplementation(async function (this: RepositoryStore, path, options) {
      if (path === second) throw new Error('checkout is locked');
      return remove.call(this, path, options);
    });
    const report = await inspect(workItemId);
    expect(report.cleanup).toMatchObject({ status: 'partial', reason: expect.stringContaining('locked') });
    expect(report.cleanup!.bytes).toBeGreaterThan(0);
    await expect(lstat(checkout)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(second, 'tracked.txt'), 'utf8')).toBe('baseline\n');
  });

  it('retains an actively leased workspace', async () => {
    const lease = await leases.acquire([key]);
    try { await retained('active repository lease'); }
    finally { await lease.release(); }
  });

  it('retains work when lease ownership cannot be inspected', async () => {
    const report = await inspectWorkspaceDisk({ root, manifests: [manifestPath], cleanup: workItemId,
      leases: { active: async () => { throw new Error('unknown lease'); } } });
    expect(report.workspaces[0]).toMatchObject({ active: null, reclaimableBytes: 0 });
    expect(report.cleanup).toMatchObject({ status: 'retained', reason: expect.stringContaining('unknown lease') });
    expect(await lstat(checkout)).toBeDefined();
  });

  it('retains a workspace with ambiguous duplicate manifests', async () => {
    const report = await inspectWorkspaceDisk({ root, manifests: [manifestPath, manifestPath], leases, cleanup: workItemId });
    expect(report.workspaces[0].reclaimableBytes).toBe(0);
    expect(report.cleanup).toMatchObject({ status: 'retained' });
    expect(report.diagnostics.join('\n')).toContain('duplicate workspace manifest');
    expect(await lstat(checkout)).toBeDefined();
  });

  it.each(['verification', 'blocked', 'requested', 'failed', 'unknown'])('retains %s executions', async state => {
    await phase(state);
    await retained('not safely completed');
  });

  it('does not hide an unresolved verification attempt behind a later completed journal', async () => {
    await writeFile(join(dirname(journal), 'verification.jsonl'), JSON.stringify({ phase: 'verification', at: '2026-11-03T12:00:00Z' }));
    await retained('not safely completed');
  });

  it.each(['missing', 'malformed', 'lock'])('retains %s execution evidence', async kind => {
    if (kind === 'missing') await rm(journal);
    if (kind === 'malformed') await writeFile(journal, '{incomplete');
    if (kind === 'lock') await writeFile(join(dirname(journal), 'attempt.lock'), 'unknown owner');
    await retained();
  });

  it.each(['tracked', 'staged', 'untracked', 'outer', 'unpublished'])('preserves %s work', async kind => {
    if (kind === 'tracked' || kind === 'staged') await writeFile(join(checkout, 'tracked.txt'), 'edited\n');
    if (kind === 'staged') await simpleGit(checkout).add('tracked.txt');
    if (kind === 'untracked') await writeFile(join(checkout, 'notes.txt'), 'keep');
    if (kind === 'outer') await writeFile(join(workspace, 'notes.txt'), 'keep');
    if (kind === 'unpublished') {
      await simpleGit(checkout).addConfig('user.name', 'AFK Test');
      await simpleGit(checkout).addConfig('user.email', 'afk@example.test');
      await simpleGit(checkout).commit('local only', undefined, ['--allow-empty']);
    }
    const report = await inspect(workItemId);
    expect(report.cleanup?.status).toBe('retained');
    expect(report.workspaces[0].reclaimableBytes).toBe(0);
    expect(await lstat(checkout)).toBeDefined();
    if (kind === 'tracked' || kind === 'staged') expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('edited\n');
  });

  it('retains an ordinary source clone even when clean and completed', async () => {
    await rm(checkout, { recursive: true });
    await simpleGit().clone(join(temporary, 'source'), checkout);
    await retained('unmanaged');
  });

  it.each(['--assume-unchanged', '--skip-worktree'])('preserves tracked changes hidden by %s', async flag => {
    await simpleGit(checkout).raw(['update-index', flag, 'tracked.txt']);
    await writeFile(join(checkout, 'tracked.txt'), 'hidden edit\n');
    const report = await inspect(workItemId);
    expect(report.cleanup?.status).toBe('retained');
    expect(report.cleanup?.reason).toContain('hides tracked changes');
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('hidden edit\n');
  });

  it.each(['.env', 'local.config', 'private/notes.txt', 'node_modules/generated'])('preserves ignored content at %s', async path => {
    const ignored = join(checkout, path);
    await mkdir(dirname(ignored), { recursive: true });
    await writeFile(ignored, 'secret must stay local');
    const report = await retained('ignored content');
    expect(await readFile(ignored, 'utf8')).toBe('secret must stay local');
    expect(report.diagnostics.join('\n')).not.toContain('secret must stay local');
  });

  it.each(['running', 'stale', 'unknown'])('preserves verification tasks with %s status', async status => {
    const path = join(workspaceStateDirectory(), 'runtime/tasks/active/task.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ backlogId: '913', status, phase: 'verifying', worktree: checkout }));
    await retained('verification/execution task');
  });

  it('retains work when active task metadata is unreadable', async () => {
    const path = join(workspaceStateDirectory(), 'runtime/tasks/active/task.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{}');
    await retained('unknown active task');
  });

  it.each(['workspace', 'worktree', 'providerRef'])('does not match the same provider issue number in another project with known %s', async scope => {
    const other = executionWorkspacePath('github:other/project#913', root);
    await mkdir(other, { recursive: true });
    const task = { backlogId: '913', status: 'running', phase: 'verifying',
      [scope]: scope === 'providerRef' ? 'github:other/project#913' : other };
    const path = join(workspaceStateDirectory(), 'runtime/tasks/active/task.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(task));
    expect((await inspect(workItemId)).cleanup?.status).toBe('removed');
    expect(await lstat(other)).toBeDefined();
  });

  it.each(['unscoped', 'missing-path', 'matching-provider', 'symlink'])('retains matching-number tasks with %s scope', async scope => {
    const task: Record<string, string> = { backlogId: '913', status: 'running', phase: 'verifying' };
    if (scope === 'missing-path') task.workspace = join(temporary, 'unknown-workspace');
    if (scope === 'matching-provider') {
      task.workspace = join(temporary, 'source');
      task.providerRef = workItemId;
    }
    if (scope === 'symlink') {
      task.workspace = join(temporary, 'task-alias');
      await symlink(workspace, task.workspace);
    }
    const path = join(workspaceStateDirectory(), 'runtime/tasks/active/task.json');
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(task));
    await retained('verification/execution task');
  });

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
  }

  async function cleanupQueuedBehindStoreGate(mutate: () => Promise<void>) {
    const entered = deferred();
    const release = deferred();
    const waiting = deferred();
    const store = new RepositoryStore(join(root, 'repos'));
    const held = store.withCheckoutLock(checkout, async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const exclusive = FilesystemClaimLock.prototype.withExclusiveOperation;
    const spy = vi.spyOn(FilesystemClaimLock.prototype, 'withExclusiveOperation').mockImplementation(function<Result>(
      this: FilesystemClaimLock, key: string, operation: () => Promise<Result>,
    ): Promise<Result> {
      if (key.endsWith('/git')) waiting.resolve();
      return exclusive.call(this, key, operation) as Promise<Result>;
    });
    const cleanup = inspect(workItemId);
    try {
      await waiting.promise;
      await mutate();
      release.resolve();
      return await cleanup;
    } finally {
      release.resolve();
      await held;
      await cleanup;
      spy.mockRestore();
    }
  }

  it('rechecks dirty files after waiting for the actual store deletion gate', async () => {
    const report = await cleanupQueuedBehindStoreGate(() => writeFile(join(checkout, 'tracked.txt'), 'changed during gate wait'));
    expect(report.cleanup?.status).toBe('retained');
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('changed during gate wait');
  });

  it('retains a nested QA worktree created while waiting for the actual store gate', async () => {
    const verification = join(checkout, '.verification');
    const report = await cleanupQueuedBehindStoreGate(async () => {
      await simpleGit(bare).raw(['worktree', 'add', '--detach', verification, 'HEAD']);
    });
    expect(report.cleanup).toMatchObject({ status: 'retained', reason: expect.stringContaining('nested verification') });
    expect(await readFile(join(verification, 'tracked.txt'), 'utf8')).toBe('baseline\n');
  });

  it('does not follow a checkout symlink swapped in while waiting for the actual store gate', async () => {
    const external = join(temporary, 'outside-target');
    const saved = join(temporary, 'saved-checkout');
    await simpleGit(bare).raw(['worktree', 'add', '--detach', external, 'HEAD']);
    const report = await cleanupQueuedBehindStoreGate(async () => {
      await rename(checkout, saved);
      await symlink(external, checkout);
    });
    expect(report.cleanup).toMatchObject({ status: 'retained', reason: expect.stringContaining('symlink') });
    expect(await readFile(join(external, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    expect(await readFile(join(saved, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    expect(await simpleGit(bare).raw(['worktree', 'list', '--porcelain'])).toContain(external);
  });

  it('rejects a different checkout directory at the same lexical path after the store gate wait', async () => {
    const saved = join(temporary, 'saved-checkout');
    const report = await cleanupQueuedBehindStoreGate(async () => {
      await rename(checkout, saved);
      await cp(saved, checkout, { recursive: true });
    });
    expect(report.cleanup).toMatchObject({ status: 'retained', reason: expect.stringContaining('identity changed') });
    expect(await readFile(join(checkout, 'tracked.txt'), 'utf8')).toBe('baseline\n');
    expect(await readFile(join(saved, 'tracked.txt'), 'utf8')).toBe('baseline\n');
  });

  it('preserves nested ignored QA worktrees', async () => {
    const verification = join(checkout, '.verification');
    await simpleGit(bare).raw(['worktree', 'add', '--detach', verification, 'HEAD']);
    await retained('nested verification');
    expect(await readFile(join(verification, 'tracked.txt'), 'utf8')).toBe('baseline\n');
  });

  it.each(['workspace', 'ancestor', 'checkout', 'journal', 'manifest'])('rejects a symlinked %s', async kind => {
    const path = kind === 'workspace' ? workspace : kind === 'ancestor' ? dirname(workspace)
      : kind === 'checkout' ? checkout : kind === 'journal' ? journal : manifestPath;
    const destination = join(temporary, 'symlink-target');
    await rename(path, destination);
    await symlink(destination, path);
    const report = await inspect(workItemId);
    expect(report.cleanup?.status).toBe('retained');
    expect(report.diagnostics.join('\n')).toContain('symlink');
    expect(await lstat(destination)).toBeDefined();
  });

  it.each(['checkout', 'identity', 'root'])('rejects manifest %s path escapes', async kind => {
    const value = manifest();
    if (kind === 'checkout') value.repositories[0].checkoutPath = '../../source';
    if (kind === 'identity') value.workItemId = '../source';
    await writeFile(manifestPath, JSON.stringify(kind === 'root' ? { ...value, workspaceRoot: temporary } : value));
    await retained();
    expect(await readFile(join(temporary, 'source/tracked.txt'), 'utf8')).toBe('baseline\n');
  });

  it.each(['../source', '.', '/', 'all', 'github:doctor-test/api#91'])('rejects the nonexact cleanup target %s', async target => {
    expect((await inspect(target)).cleanup).toMatchObject({ status: 'retained', bytes: 0 });
    expect(await lstat(checkout)).toBeDefined();
  });

  it('rechecks completion and cleanliness after acquiring the lease', async () => {
    const report = await inspectWorkspaceDisk({ root, manifests: [manifestPath], cleanup: workItemId, leases: {
      active: leases.active.bind(leases),
      run: async (keys, operation) => leases.run(keys, async () => { await phase('verification'); return operation(); }),
    } });
    expect(report.cleanup).toMatchObject({ status: 'retained', reason: expect.stringContaining('no longer completed') });
    expect(await lstat(checkout)).toBeDefined();
  });

  it('does not delete when a lease appears after inventory', async () => {
    let release = async () => {};
    try {
      const report = await inspectWorkspaceDisk({ root, manifests: [manifestPath], cleanup: workItemId, leases: {
        active: async () => { const lease = await leases.acquire([key]); release = lease.release; return false; },
        run: leases.run.bind(leases),
      } });
      expect(report.cleanup).toMatchObject({ status: 'retained', reason: expect.stringContaining('leased') });
      expect(await lstat(checkout)).toBeDefined();
    } finally { await release(); }
  });

  async function dependency(character = 'a'): Promise<string> {
    const entry = join(root, 'deps', character.repeat(64));
    await mkdir(join(entry, 'layout/node_modules'), { recursive: true });
    await mkdir(join(entry, 'pins'));
    await writeFile(join(entry, 'complete.json'), JSON.stringify({ paths: ['node_modules'] }));
    await writeFile(join(entry, 'layout/node_modules/generated'), 'cache');
    return entry;
  }

  it('removes only the explicit unpinned completed dependency entry under the pool gate', async () => {
    const target = await dependency();
    const sibling = await dependency('b');
    await writeFile(join(target, 'pins/stale'), join(temporary, 'no-longer-present'));
    const report = await inspect(target);
    expect(report.cleanup).toMatchObject({ status: 'removed', path: target });
    expect(report.cleanup!.bytes).toBeGreaterThan(0);
    await expect(lstat(target)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(sibling, 'layout/node_modules/generated'), 'utf8')).toBe('cache');
    expect(await lstat(checkout)).toBeDefined();
  });

  it('retains pinned dependencies', async () => {
    const target = await dependency();
    await writeFile(join(target, 'pins/live'), checkout);
    const report = await inspect(target);
    expect(report.dependencies[0].pinned).toBe(true);
    expect(report.cleanup?.status).toBe('retained');
    expect(await lstat(target)).toBeDefined();
  });

  it.each(['entry', 'ancestor', 'marker', 'pins'])('rejects symlinked dependency %s', async kind => {
    const target = await dependency();
    const path = kind === 'entry' ? target : kind === 'ancestor' ? dirname(target)
      : kind === 'marker' ? join(target, 'complete.json') : join(target, 'pins');
    const destination = join(temporary, 'external-cache');
    await rename(path, destination);
    await symlink(destination, path);
    const report = await inspect(target);
    expect(report.cleanup?.status).toBe('retained');
    expect(await lstat(destination)).toBeDefined();
  });

  it.each(['paths', 'unknown', 'layout', 'version', 'pin', 'incomplete'])('retains dependency entries with %s metadata', async kind => {
    const target = await dependency();
    if (kind === 'paths') await writeFile(join(target, 'complete.json'), JSON.stringify({ paths: ['../../node_modules'] }));
    if (kind === 'unknown') await writeFile(join(target, 'notes.txt'), 'keep');
    if (kind === 'layout') await writeFile(join(target, 'layout/source.txt'), 'keep');
    if (kind === 'version') await writeFile(join(target, 'complete.json'), JSON.stringify({ paths: ['node_modules'], schemaVersion: 999 }));
    if (kind === 'pin') await writeFile(join(target, 'pins/invalid'), 'relative-checkout');
    if (kind === 'incomplete') await rm(join(target, 'complete.json'));
    expect((await inspect(target)).cleanup?.status).toBe('retained');
    expect(await lstat(target)).toBeDefined();
  });
});
