import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { constants, promises as fs, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RepositoryStore } from '../git/repository-store.js';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';
import { repositoryLeaseKey } from '../git/repository-lease.js';
import { MultiRepositoryProvider } from './repositories.js';
import { RepositoryRecoveryJournal, type RepositoryRecoveryRecord } from './repository-recovery.js';
import * as sqlite from '../storage/sqlite.js';

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function git(path: string, args: string[]): string {
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', path, ...args], { encoding: 'utf8', stdio: 'pipe', env: environment }).trim();
}

type CrashPhase = 'reserved' | 'owned' | 'checkout' | 'publish' | 'cleanup-before-remove' | 'cleanup-removed' | 'recovery-removed'
  | 'prepare-owned-removed' | 'prepare-reserved-removed' | 'reservation-closed' | 'reservation-before-rename';

async function crashFixture(phase: CrashPhase = 'owned') {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'afk-durable-recovery-')));
  roots.push(root);
  const source = join(root, 'source');
  await fs.mkdir(source);
  git(source, ['init', '-b', 'main']);
  git(source, ['config', 'user.name', 'Fixture']);
  git(source, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(join(source, 'tracked.txt'), 'fixture\n');
  git(source, ['add', '.']);
  git(source, ['commit', '-m', 'fixture']);
  const storeRoot = join(root, 'store');
  await fs.mkdir(storeRoot);
  const bare = join(storeRoot, 'fixture.git');
  git(source, ['clone', '--bare', '--no-hardlinks', source, bare]);
  git(bare, ['remote', 'set-url', 'origin', 'https://fixture.invalid/repo.git']);
  const workspaceRoot = join(root, 'workspaces');
  const leaseStateRoot = join(root, 'leases');
  const leaseKey = 'gitlab:fixture.invalid/repo';
  const repositories = [{ name: 'repo', path: source, remoteUrl: 'https://fixture.invalid/repo.git', baseBranch: 'main', leaseKey }];
  const modulePath = fileURLToPath(new URL('./repositories.ts', import.meta.url));
  const storePath = fileURLToPath(new URL('../git/repository-store.ts', import.meta.url));
  const journalPath = fileURLToPath(new URL('./repository-recovery.ts', import.meta.url));
  const code = `
    import { execFileSync } from 'node:child_process';
    import { promises as fs } from 'node:fs';
    import { MultiRepositoryProvider } from ${JSON.stringify(modulePath)};
    import { RepositoryStore } from ${JSON.stringify(storePath)};
    import { RepositoryRecoveryJournal } from ${JSON.stringify(journalPath)};
    const data = JSON.parse(process.argv[1]);
    const controller = new AbortController();
    const store = new RepositoryStore(data.storeRoot);
    store.ensureCheckout = async (_url, path) => {
      if (data.phase === 'reserved') process.kill(process.pid, 'SIGKILL');
      if (['prepare-reserved-removed', 'reservation-closed', 'reservation-before-rename'].includes(data.phase)) throw new Error('checkout unavailable');
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', data.bare, 'worktree', 'add', '--detach', path, 'main'], { stdio: 'pipe' });
      if (data.phase === 'recovery-removed' || data.phase === 'prepare-owned-removed') controller.abort(new Error('cancelled preparation'));
    };
    const terminate = async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); };
    if (data.phase === 'cleanup-before-remove') {
      const removing = RepositoryRecoveryJournal.prototype.removing;
      RepositoryRecoveryJournal.prototype.removing = async function (...args) { await removing.apply(this, args); await terminate(); };
    }
    if (['cleanup-removed', 'recovery-removed', 'prepare-owned-removed', 'prepare-reserved-removed'].includes(data.phase)) RepositoryRecoveryJournal.prototype.close = terminate;
    if (data.phase === 'reservation-closed') {
      const close = RepositoryRecoveryJournal.prototype.close;
      RepositoryRecoveryJournal.prototype.close = async function (id) {
        await close.call(this, id);
        process.stdout.write(JSON.stringify(await this.get(id)), () => process.kill(process.pid, 'SIGKILL'));
        await new Promise(() => {});
      };
    }
    if (data.phase === 'reservation-before-rename') {
      const rename = fs.rename;
      fs.rename = async (...args) => { if (String(args[1]).includes('/reservation-')) await terminate(); return rename(...args); };
    }
    const provider = new MultiRepositoryProvider({ repositories: data.repositories,
      git: async request => {
        if (data.phase === 'owned' || (data.phase === 'checkout' && request.args[0] === 'switch')
          || (data.phase === 'publish' && request.args.includes('push'))) await terminate();
        return { stdout: execFileSync(request.command, request.args, { cwd: request.cwd, encoding: 'utf8', stdio: 'pipe' }), stderr: '' };
      },
      managed: { workspaceRoot: data.workspaceRoot, leaseStateRoot: data.leaseStateRoot, store } });
    if (data.phase === 'recovery-removed') {
      const remove = store.removeCheckout.bind(store);
      store.removeCheckout = async () => { throw new Error('cleanup unavailable'); };
      try { await provider.prepare({ repository: { url: 'repo' }, runId: 'crashed-run' }, { signal: controller.signal }); }
      catch (error) { if (error.name !== 'RepositoryPreparationCleanupError') throw error; }
      store.removeCheckout = remove;
      const [record] = await provider.listRecoveryAllocations();
      await provider.recoverAllocation(record.allocation.id);
    } else {
      const workspace = await provider.prepare({ repository: { url: 'repo' }, runId: 'crashed-run' }, { signal: controller.signal });
      if (data.phase === 'checkout' || data.phase === 'publish') await provider.checkout({ workspaceId: workspace.id });
      if (data.phase === 'publish') await provider.publish({ workspaceId: workspace.id });
      if (data.phase.startsWith('cleanup-')) await provider.cleanup({ workspaceId: workspace.id });
    }
  `;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code,
    JSON.stringify({ phase, storeRoot, bare, repositories, workspaceRoot, leaseStateRoot })], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '';
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const [exitCode, signal] = await once(child, 'close');
  expect({ exitCode, signal, stderr }).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
  const store = new RepositoryStore(storeRoot);
  const provider = new MultiRepositoryProvider({ repositories, managed: { workspaceRoot, leaseStateRoot, store } });
  const records = await provider.listRecoveryAllocations();
  expect(records).toHaveLength(phase === 'reservation-closed' ? 0 : 1);
  const record: RepositoryRecoveryRecord = phase === 'reservation-closed' ? JSON.parse(stdout) : records[0];
  expect(record.phase).toBe(phase === 'reserved' ? 'reserved' : phase === 'reservation-closed' ? 'closed'
    : phase.startsWith('cleanup-') || phase === 'recovery-removed' || phase.startsWith('prepare-') || phase === 'reservation-before-rename' ? 'removing' : 'owned');
  expect(record.owner.pid).toBe(child.pid);
  expect(record.owner.claims).toHaveLength(1);
  const claim = await new FilesystemClaimLock(leaseStateRoot).inspect(repositoryLeaseKey(leaseKey));
  expect(claim).not.toBeNull();
  expect(record.owner.claims).toContain(claim!.claimId);
  const expire = () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(Date.now() + 120000); };
  return { root, source, bare, store, provider, record, repositories, workspaceRoot, leaseStateRoot, leaseKey, expire };
}

describe('durable Repository allocation recovery', () => {
  it('precreates a private database before the native SQLite constructor runs', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'afk-recovery-private-')));
    roots.push(root);
    const open = sqlite.openSqlite;
    let observed = false;
    vi.spyOn(sqlite, 'openSqlite').mockImplementation(options => {
      const metadata = statSync(options.file);
      expect({ mode: metadata.mode & 0o777, nlink: metadata.nlink }).toEqual({ mode: 0o600, nlink: 1 });
      observed = true;
      return open(options);
    });
    const journal = new RepositoryRecoveryJournal(root);
    await fs.mkdir(journal.directory, { mode: 0o700 });
    expect(await journal.list()).toEqual([]);
    expect(observed).toBe(true);
  });

  it('revalidates a sidecar unlinked after opening its real descriptor', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'afk-recovery-unlink-')));
    roots.push(root);
    const journal = new RepositoryRecoveryJournal(root);
    await fs.mkdir(journal.directory, { mode: 0o700 });
    await journal.list();
    const sidecar = join(journal.directory, 'allocations.sqlite-shm');
    await fs.writeFile(sidecar, '', { mode: 0o600 });
    const open = fs.open;
    let unlinked = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === sidecar && !unlinked) {
        await fs.unlink(sidecar);
        expect((await handle.stat()).nlink).toBe(0);
        unlinked = true;
      }
      return handle;
    });
    expect(await journal.list()).toEqual([]);
    expect(unlinked).toBe(true);
  });

  it('bounds actual sidecar replacement retries and reports busy separately from private guard rejection', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'afk-recovery-busy-')));
    roots.push(root);
    const journal = new RepositoryRecoveryJournal(root);
    await fs.mkdir(journal.directory, { mode: 0o700 });
    await journal.list();
    const sidecar = join(journal.directory, 'allocations.sqlite-shm');
    await fs.writeFile(sidecar, '', { mode: 0o600 });
    const open = fs.open;
    let replacements = 0;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === sidecar) {
        await fs.unlink(sidecar);
        await fs.writeFile(sidecar, '', { mode: 0o600 });
        replacements += 1;
      }
      return handle;
    });
    await expect(journal.list()).rejects.toThrow('Repository recovery storage is busy: sidecar changed during validation');
    expect(replacements).toBe(8);
    expect((await fs.lstat(sidecar)).nlink).toBe(1);
  });

  it.each(['', '-wal', '-shm', '-journal'])('rejects symlink, broad permissions and hardlinks for SQLite %s', async suffix => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'afk-recovery-guard-')));
    roots.push(root);
    const journal = new RepositoryRecoveryJournal(root);
    await fs.mkdir(journal.directory, { mode: 0o700 });
    await journal.list();
    const file = join(journal.directory, `allocations.sqlite${suffix}`);
    const foreign = join(root, 'foreign');
    await fs.writeFile(foreign, 'foreign content', { mode: 0o600 });
    await fs.rm(file, { force: true });
    await fs.symlink(foreign, file);
    await expect(journal.list()).rejects.toThrow(/not private/i);
    expect(await fs.readFile(foreign, 'utf8')).toBe('foreign content');
    await fs.unlink(file);
    await fs.writeFile(file, '', { mode: 0o644 });
    await expect(journal.list()).rejects.toThrow(/not private/i);
    expect((await fs.lstat(file)).mode & 0o777).toBe(0o644);
    await fs.unlink(file);
    await fs.link(foreign, file);
    await expect(journal.list()).rejects.toThrow(/not private/i);
    expect((await fs.lstat(file)).nlink).toBe(2);
    expect(await fs.readFile(foreign, 'utf8')).toBe('foreign content');
  });

  it('rejects foreign descriptor ownership without repairing permissions', async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'afk-recovery-owner-')));
    roots.push(root);
    const journal = new RepositoryRecoveryJournal(root);
    await fs.mkdir(journal.directory, { mode: 0o700 });
    await journal.list();
    const open = fs.open;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === join(journal.directory, 'allocations.sqlite') && args[1] === (constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)) {
        const stat = handle.stat.bind(handle);
        vi.spyOn(handle, 'stat').mockImplementation(async options => {
          const metadata = await stat(options);
          return Object.assign(metadata, { uid: Number(metadata.uid) + 1 });
        });
      }
      return handle;
    });
    await expect(journal.list()).rejects.toThrow(/not private/i);
    expect((await fs.lstat(join(journal.directory, 'allocations.sqlite'))).mode & 0o777).toBe(0o600);
  });

  it.each(['prepare-owned-removed', 'prepare-reserved-removed'] as const)('persists the compensation generation across actual SIGKILL at %s', async phase => {
    const test = await crashFixture(phase);
    await expect(fs.lstat(test.record.allocation.path)).rejects.toMatchObject({ code: 'ENOENT' });
    if (phase === 'prepare-reserved-removed') {
      expect(test.record.reservationRemoval).toBeDefined();
      expect((await fs.lstat(test.record.reservationRemoval!.witness)).ino).toBe(test.record.directory!.ino);
    }
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/lease.*active/i);
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).resolves.toEqual({ removed: true });
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).resolves.toEqual({ removed: true });
    expect(await test.provider.listRecoveryAllocations()).toEqual([]);
  });

  it.each(['reservation-closed', 'reservation-before-rename'] as const)('recovers a real kill at %s without treating missing as evidence', async phase => {
    const test = await crashFixture(phase);
    expect(test.record.reservationRemoval).toBeDefined();
    if (phase === 'reservation-before-rename') expect((await fs.lstat(test.record.allocation.path)).ino).toBe(test.record.directory!.ino);
    else expect((await fs.lstat(test.record.reservationRemoval!.witness)).ino).toBe(test.record.directory!.ino);
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).resolves.toEqual({ removed: true });
    expect(await test.provider.listRecoveryAllocations()).toEqual([]);
    expect((await fs.lstat(test.record.reservationRemoval!.witness)).ino).toBe(test.record.directory!.ino);
  });

  it.each(['moved', 'replaced', 'populated'] as const)('retains a reserved directory %s before staging', async action => {
    const test = await crashFixture('reserved');
    const path = test.record.allocation.path;
    if (action === 'populated') await fs.writeFile(join(path, 'foreign'), 'preserved');
    else {
      await fs.rename(path, `${path}-moved`);
      if (action === 'replaced') await fs.mkdir(path);
    }
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow();
    expect(await test.provider.listRecoveryAllocations()).toHaveLength(1);
    const preserved = action === 'populated' ? path : `${path}-moved`;
    expect((await fs.lstat(preserved)).ino).toBe(test.record.directory!.ino);
  });

  it('refuses a replaced private witness parent while preserving the original tombstone', async () => {
    const test = await crashFixture('prepare-reserved-removed');
    const directory = join(test.workspaceRoot, '.afk-repository-recovery');
    const moved = `${directory}-moved`;
    await fs.rename(directory, moved);
    await fs.mkdir(directory, { mode: 0o700 });
    await fs.copyFile(join(moved, 'allocations.sqlite'), join(directory, 'allocations.sqlite'));
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/parent changed/i);
    const witnessName = `reservation-${test.record.allocation.id}`;
    expect((await fs.lstat(join(moved, witnessName))).ino).toBe(test.record.directory!.ino);
  });

  it.each(['prepare-reserved-removed', 'reservation-closed'] as const)('never steals an unknown lease generation for %s', async phase => {
    const test = await crashFixture(phase);
    test.expire();
    const locks = new FilesystemClaimLock(test.leaseStateRoot, { onExpiredClaim: async () => true });
    const unknown = await locks.acquire({ key: repositoryLeaseKey(test.leaseKey), owner: 'unknown reservation owner', ttlMs: 1 });
    expect(unknown).not.toBeNull();
    vi.setSystemTime(Date.now() + 120000);
    try {
      await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/lease.*active or unknown/i);
      const claim = await locks.inspect(repositoryLeaseKey(test.leaseKey));
      expect(test.record.owner.claims).not.toContain(claim!.claimId);
      expect((await fs.lstat(test.record.reservationRemoval!.witness)).ino).toBe(test.record.directory!.ino);
    } finally { await unknown!.release(); }
  });

  it.each(['moved', 'replaced', 'populated', 'symlink', 'original-reappeared'] as const)('refuses a reservation witness %s after migration and close failure', async action => {
    const test = await crashFixture('reserved');
    test.expire();
    vi.spyOn(RepositoryRecoveryJournal.prototype, 'close').mockRejectedValueOnce(new Error('close unavailable'));
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow('close unavailable');
    const [record] = await test.provider.listRecoveryAllocations();
    expect(record).toMatchObject({ phase: 'removing', retryable: true });
    const witness = record.reservationRemoval!.witness;
    if (action === 'populated') await fs.writeFile(join(witness, 'foreign'), 'preserved');
    else if (action === 'original-reappeared') await fs.mkdir(record.allocation.path);
    else {
      await fs.rename(witness, `${witness}-moved`);
      if (action === 'replaced') await fs.mkdir(witness);
      if (action === 'symlink') await fs.symlink(`${witness}-moved`, witness);
    }
    await expect(test.provider.recoverAllocation(record.allocation.id)).rejects.toThrow(/witness|reappeared|directory changed/i);
    expect(await test.provider.listRecoveryAllocations()).toHaveLength(1);
    if (action === 'populated') expect(await fs.readFile(join(witness, 'foreign'), 'utf8')).toBe('preserved');
  });

  it('retries reservation close failure in the same process and retains its exact durable tombstone', async () => {
    const test = await crashFixture('reserved');
    test.expire();
    vi.spyOn(RepositoryRecoveryJournal.prototype, 'close').mockRejectedValueOnce(new Error('close unavailable'));
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow('close unavailable');
    const [record] = await test.provider.listRecoveryAllocations();
    expect((await fs.lstat(record.reservationRemoval!.witness)).ino).toBe(record.directory!.ino);
    await expect(test.provider.recoverAllocation(record.allocation.id)).resolves.toEqual({ removed: true });
    await expect(test.provider.recoverAllocation(record.allocation.id)).resolves.toEqual({ removed: true });
    expect(await test.provider.listRecoveryAllocations()).toEqual([]);
    expect((await fs.lstat(record.reservationRemoval!.witness)).ino).toBe(record.directory!.ino);
  });

  it.each(['moved', 'deleted', 'replaced', 'populated', 'symlink', 'original-reappeared'] as const)('refuses a closed reservation whose permanent witness was %s', async action => {
    const test = await crashFixture('reserved');
    test.expire();
    await test.provider.recoverAllocation(test.record.allocation.id);
    const journal = new RepositoryRecoveryJournal(test.workspaceRoot, test.leaseStateRoot);
    const record = await journal.get(test.record.allocation.id);
    expect(record.phase).toBe('closed');
    expect(record.owner.claims).not.toEqual(test.record.owner.claims);
    const witness = record.reservationRemoval!.witness;
    if (action === 'deleted') await fs.rmdir(witness);
    else if (action === 'populated') await fs.writeFile(join(witness, 'foreign'), 'preserved');
    else if (action === 'original-reappeared') await fs.mkdir(record.allocation.path);
    else {
      await fs.rename(witness, `${witness}-moved`);
      if (action === 'replaced') await fs.mkdir(witness);
      if (action === 'symlink') await fs.symlink(`${witness}-moved`, witness);
    }
    expect(await test.provider.listRecoveryAllocations()).toHaveLength(1);
    const reopened = new MultiRepositoryProvider({ repositories: test.repositories,
      managed: { workspaceRoot: test.workspaceRoot, leaseStateRoot: test.leaseStateRoot, store: test.store } });
    await expect(reopened.recoverAllocation(record.allocation.id)).rejects.toThrow(/witness|reappeared/i);
    expect(await reopened.listRecoveryAllocations()).toHaveLength(1);
  });
  it.each(['checkout', 'publish', 'cleanup-before-remove'] as const)('binds the current %s lease generation before changing the allocation', async phase => {
    const test = await crashFixture(phase);
    expect(await test.store.ownsCheckout(test.record.allocation.path)).toBe(true);
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/lease.*active/i);
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).resolves.toEqual({ removed: true });
    expect(await test.provider.listRecoveryAllocations()).toEqual([]);
  });

  it.each(['cleanup-removed', 'recovery-removed'] as const)('settles %s only with the original missing registration under the Store lock', async phase => {
    const test = await crashFixture(phase);
    expect(test.record.removal?.common.path).toBe(test.bare);
    await expect(fs.lstat(test.record.allocation.path)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(test.record.removal!.administration.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(test.bare, ['worktree', 'list', '--porcelain'])).not.toContain(test.record.allocation.path);
    const lock = vi.spyOn(test.store, 'withCheckoutLock');
    const remove = vi.spyOn(test.store, 'removeCheckout');
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).resolves.toEqual({ removed: true });
    expect(lock).toHaveBeenCalledWith(test.bare, expect.any(Function));
    expect(remove).not.toHaveBeenCalled();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).resolves.toEqual({ removed: true });
    expect(await test.provider.listRecoveryAllocations()).toEqual([]);
  });

  it('preserves the deletion phase when its still-registered checkout was moved', async () => {
    const test = await crashFixture('cleanup-before-remove');
    const moved = `${test.record.allocation.path}-moved`;
    git(test.bare, ['worktree', 'move', test.record.allocation.path, moved]);
    test.expire();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/moved|registered|incomplete/i);
      const [record] = await test.provider.listRecoveryAllocations();
      expect(record).toMatchObject({ phase: 'removing', retryable: true, removal: test.record.removal });
      expect(await fs.readFile(join(moved, 'tracked.txt'), 'utf8')).toBe('fixture\n');
    }
  });

  it('refuses to settle a missing checkout through a different Store', async () => {
    const test = await crashFixture('cleanup-removed');
    const foreign = new MultiRepositoryProvider({ repositories: test.repositories, managed: { workspaceRoot: test.workspaceRoot,
      leaseStateRoot: test.leaseStateRoot, store: new RepositoryStore(join(test.root, 'foreign-store')) } });
    test.expire();
    await expect(foreign.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/Store is not owned/i);
    expect((await test.provider.listRecoveryAllocations())[0]).toMatchObject({ phase: 'removing', retryable: true });
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).resolves.toEqual({ removed: true });
  });

  it('keeps an unknown administration directory and settles only after that obstruction is removed', async () => {
    const test = await crashFixture('cleanup-removed');
    const administration = test.record.removal!.administration.path;
    await fs.mkdir(administration, { recursive: true });
    await fs.writeFile(join(administration, 'sentinel'), 'keep unknown registration');
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/incomplete|registered/i);
    const [record] = await test.provider.listRecoveryAllocations();
    expect(record).toMatchObject({ phase: 'removing', retryable: true, removal: test.record.removal });
    expect(await fs.readFile(join(administration, 'sentinel'), 'utf8')).toBe('keep unknown registration');
    await fs.rm(administration, { recursive: true });
    await expect(test.provider.recoverAllocation(record.allocation.id)).resolves.toEqual({ removed: true });
  });

  it('refuses to settle after the original Store common directory was replaced', async () => {
    const test = await crashFixture('cleanup-removed');
    await fs.rename(test.bare, `${test.bare}-original`);
    git(test.source, ['clone', '--bare', '--no-hardlinks', test.source, test.bare]);
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/Store identity changed/i);
    expect((await test.provider.listRecoveryAllocations())[0]).toMatchObject({ phase: 'removing', retryable: true });
    expect((await fs.lstat(`${test.bare}-original`)).isDirectory()).toBe(true);
  });

  it('refuses missing without a persisted deletion intent even when Git registration is gone', async () => {
    const test = await crashFixture();
    await test.store.removeCheckout(test.record.allocation.path, { force: false });
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/disappeared/i);
    expect(await test.provider.listRecoveryAllocations()).toHaveLength(1);
  });

  it.each(['reserved', 'owned'] as const)('reopens a killed %s owner and reclaims only after its bound lease expires', async phase => {
    const test = await crashFixture(phase);
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/lease.*active/i);
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).resolves.toEqual({ removed: true });
    expect(await test.provider.listRecoveryAllocations()).toEqual([]);
    await expect(fs.stat(test.record.allocation.path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(git(test.bare, ['worktree', 'list', '--porcelain'])).not.toContain(test.record.allocation.path);
  });

  it.each(['tracked', 'untracked', 'ignored', 'commit', 'replaced', 'nested'] as const)('preserves %s resources and their durable record', async content => {
    const test = await crashFixture();
    const path = test.record.allocation.path;
    if (content === 'tracked') await fs.writeFile(join(path, 'tracked.txt'), 'keep tracked');
    if (content === 'untracked') await fs.writeFile(join(path, 'untracked.txt'), 'keep untracked');
    if (content === 'ignored') {
      await fs.writeFile(join(test.bare, 'info', 'exclude'), 'ignored.txt\n');
      await fs.writeFile(join(path, 'ignored.txt'), 'keep ignored');
    }
    if (content === 'commit') {
      await fs.writeFile(join(path, 'tracked.txt'), 'keep unpublished');
      git(path, ['add', '.']);
      git(path, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'unpublished']);
    }
    if (content === 'replaced') {
      git(test.bare, ['worktree', 'move', path, `${path}-original`]);
      git(test.bare, ['worktree', 'add', '--detach', path, 'main']);
    }
    if (content === 'nested') git(test.bare, ['worktree', 'add', '--detach', join(path, 'nested'), 'main']);
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow();
    expect((await test.provider.listRecoveryAllocations())[0].allocation).toEqual(test.record.allocation);
    expect((await fs.stat(path)).isDirectory()).toBe(true);
  });

  it('never steals a new active generation after the original crashed owner', async () => {
    const test = await crashFixture();
    const locks = new FilesystemClaimLock(test.leaseStateRoot, { onExpiredClaim: async () => true });
    test.expire();
    const active = await locks.acquire({ key: repositoryLeaseKey(test.leaseKey), owner: 'new active owner', ttlMs: 60000 });
    expect(active).not.toBeNull();
    try { await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/active|unknown/i); }
    finally { await active!.release(); }
    expect(await test.store.ownsCheckout(test.record.allocation.path)).toBe(true);
  });

  it('leaves a missing owned checkout unresolved instead of claiming cleanup', async () => {
    const test = await crashFixture();
    git(test.bare, ['worktree', 'move', test.record.allocation.path, `${test.record.allocation.path}-moved`]);
    test.expire();
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/disappeared/i);
    expect(await test.provider.listRecoveryAllocations()).toHaveLength(1);
    expect(await fs.readFile(join(`${test.record.allocation.path}-moved`, 'tracked.txt'), 'utf8')).toBe('fixture\n');
  });

  it('uses private persistent storage and refuses a symlink replacement', async () => {
    const test = await crashFixture();
    const directory = join(test.workspaceRoot, '.afk-repository-recovery');
    expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(join(directory, 'allocations.sqlite'))).mode & 0o777).toBe(0o600);
    await fs.rename(directory, `${directory}-original`);
    await fs.symlink(`${directory}-original`, directory);
    await expect(test.provider.listRecoveryAllocations()).rejects.toThrow(/private/i);
  });

  it('refuses changed remote configuration without touching the owned checkout', async () => {
    const test = await crashFixture();
    const changed = new MultiRepositoryProvider({ repositories: test.repositories.map(repository => ({ ...repository,
      remoteUrl: 'https://fixture.invalid/other.git' })),
    managed: { workspaceRoot: test.workspaceRoot, leaseStateRoot: test.leaseStateRoot, store: test.store } });
    test.expire();
    const remove = vi.spyOn(test.store, 'removeCheckout');
    await expect(changed.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/configured ownership/i);
    expect(remove).not.toHaveBeenCalled();
    expect(await test.store.ownsCheckout(test.record.allocation.path)).toBe(true);
  });

  it('refuses an unbound populated reservation left between Store allocation and journal ownership', async () => {
    const test = await crashFixture('reserved');
    git(test.bare, ['worktree', 'add', '--detach', test.record.allocation.path, 'main']);
    test.expire();
    const remove = vi.spyOn(test.store, 'removeCheckout');
    await expect(test.provider.recoverAllocation(test.record.allocation.id)).rejects.toThrow(/ownership is unknown/i);
    expect(remove).not.toHaveBeenCalled();
    expect(await test.provider.listRecoveryAllocations()).toHaveLength(1);
    expect(await test.store.ownsCheckout(test.record.allocation.path)).toBe(true);
  });

  it('persists the recovery lease owner and serializes competing recovery calls', async () => {
    const test = await crashFixture();
    test.expire();
    let entered!: () => void;
    let resume!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const pending = new Promise<void>(resolve => { resume = resolve; });
    const remove = test.store.removeCheckout.bind(test.store);
    vi.spyOn(test.store, 'removeCheckout').mockImplementation(async (...args) => {
      entered();
      await pending;
      return remove(...args);
    });
    const first = test.provider.recoverAllocation(test.record.allocation.id);
    try {
      await started;
      const [record] = await test.provider.listRecoveryAllocations();
      expect(record).toMatchObject({ phase: 'recovering', owner: { pid: process.pid } });
      expect(record.owner.claims).toHaveLength(1);
      expect(record.owner.claims).not.toEqual(test.record.owner.claims);
      await expect(test.provider.recoverAllocation(record.allocation.id)).rejects.toThrow(/owner is active/i);
    } finally { resume(); await first; }
    expect(await test.provider.listRecoveryAllocations()).toEqual([]);
  });
});
