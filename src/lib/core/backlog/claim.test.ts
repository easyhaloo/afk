import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemClaimLock } from './claim';

describe('FilesystemClaimLock', () => {
  const stateRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(stateRoots.splice(0).map(stateRoot => rm(stateRoot, { recursive: true, force: true })));
  });

  it('creates one filesystem lease for competing claimers', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const store = new FilesystemClaimLock(stateRoot);

    const [first, second] = await Promise.all([
      store.acquire({ key: 'github/org-repo/42', owner: 'worker-a', ttlMs: 60_000 }),
      store.acquire({ key: 'github/org-repo/42', owner: 'worker-b', ttlMs: 60_000 }),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    await first?.release();
    await second?.release();
  });

  it('does not delete a replacement claim when a stale lease releases', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const store = new FilesystemClaimLock(stateRoot);
    const lease = await store.acquire({ key: 'gitlab/group-project/9', owner: 'worker-a', ttlMs: 60_000 });
    expect(lease).not.toBeNull();

    const keyPath = join(stateRoot, 'claims', 'gitlab', 'group-project', '9');
    const claimPath = join(keyPath, 'lock', 'claim.json');
    const lockInternals = store as unknown as {
      withOperationGate<T>(path: string, operation: () => Promise<T>): Promise<T>;
    };
    let staleRelease!: Promise<void>;
    await lockInternals.withOperationGate(keyPath, async () => {
      staleRelease = lease!.release();
      const replacement = { ...JSON.parse(await readFile(claimPath, 'utf8')), claimId: 'another-worker' };
      await writeFile(claimPath, `${JSON.stringify(replacement)}\n`);
    });
    await staleRelease;

    await expect(store.acquire({ key: 'gitlab/group-project/9', owner: 'worker-b', ttlMs: 60_000 })).resolves.toBeNull();
  });

  it('rejects a lock key without provider, project, and backlog ID segments', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const store = new FilesystemClaimLock(stateRoot);

    await expect(store.acquire({ key: '42', owner: 'worker', ttlMs: 60_000 })).rejects.toThrow('provider, project, and backlog ID');
    await expect(store.acquire({ key: 'github/42', owner: 'worker', ttlMs: 60_000 })).rejects.toThrow('provider, project, and backlog ID');
  });

  it('uses AFK_STATE_DIR as the default state root', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const previousStateRoot = process.env.AFK_STATE_DIR;
    process.env.AFK_STATE_DIR = stateRoot;
    try {
      const lease = await new FilesystemClaimLock().acquire({ key: 'linear/team/ENG-42', owner: 'worker', ttlMs: 60_000 });
      expect(lease).not.toBeNull();
      await lease?.release();
    } finally {
      if (previousStateRoot === undefined) delete process.env.AFK_STATE_DIR;
      else process.env.AFK_STATE_DIR = previousStateRoot;
    }
  });

  it('recovers an expired operation gate whose local owner is no longer alive', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const keyPath = join(stateRoot, 'claims', 'github', 'org-repo', '42');
    const gatePath = join(keyPath, '.operation-gate');
    await mkdir(gatePath, { recursive: true });
    await writeFile(join(gatePath, 'gate.json'), JSON.stringify({
      gateId: 'stale-gate', owner: `${hostname()}:999999`, pid: 999999, hostname: hostname(),
      createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:01.000Z',
    }));

    const lease = await new FilesystemClaimLock(stateRoot, { gateTimeoutMs: 50, gateRetryMs: 1 }).acquire({
      key: 'github/org-repo/42', owner: 'worker', ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();
    await lease?.release();
  });

  it('recovers an empty operation gate after its bounded grace period', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const gatePath = join(stateRoot, 'claims', 'github', 'org-repo', '42', '.operation-gate');
    await mkdir(gatePath, { recursive: true });
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(gatePath, staleAt, staleAt);

    const lease = await new FilesystemClaimLock(stateRoot, { gateTimeoutMs: 50, gateRetryMs: 1, gateStaleMs: 10 }).acquire({
      key: 'github/org-repo/42', owner: 'worker', ttlMs: 60_000,
    });
    expect(lease).not.toBeNull();
    await lease?.release();
  });

  it('publishes a complete operation-gate owner record through an atomic directory rename', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const store = new FilesystemClaimLock(stateRoot);
    const keyPath = join(stateRoot, 'claims', 'github', 'org-repo', '42');
    await mkdir(keyPath, { recursive: true });
    const lockInternals = store as unknown as {
      withOperationGate<T>(path: string, operation: () => Promise<T>): Promise<T>;
    };

    await lockInternals.withOperationGate(keyPath, async () => {
      expect((await lstat(join(keyPath, '.operation-gate'))).isDirectory()).toBe(true);
    });
  });

  it('recovers an incomplete lease lock after its bounded grace period', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const lockPath = join(stateRoot, 'claims', 'github', 'org-repo', '42', 'lock');
    await mkdir(lockPath, { recursive: true });
    const staleAt = new Date(Date.now() - 60_000);
    await utimes(lockPath, staleAt, staleAt);

    const lease = await new FilesystemClaimLock(stateRoot, {
      gateTimeoutMs: 50, gateRetryMs: 1, incompleteClaimGraceMs: 10,
    }).acquire({ key: 'github/org-repo/42', owner: 'worker', ttlMs: 60_000 });

    expect(lease).not.toBeNull();
    await lease?.release();
  });

  it('does not recover a replacement lease after its stale identity was inspected', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const store = new FilesystemClaimLock(stateRoot);
    const lease = await store.acquire({ key: 'github/org-repo/42', owner: 'worker-a', ttlMs: 60_000 });
    expect(lease).not.toBeNull();

    const keyPath = join(stateRoot, 'claims', 'github', 'org-repo', '42');
    const claimPath = join(keyPath, 'lock', 'claim.json');
    const original = JSON.parse(await readFile(claimPath, 'utf8'));
    const stale = { ...original, expiresAt: '2020-01-01T00:00:01.000Z' };
    await writeFile(claimPath, `${JSON.stringify(stale)}\n`);
    const replacement = { ...stale, claimId: 'replacement-claim', expiresAt: '2999-01-01T00:00:01.000Z' };
    await writeFile(claimPath, `${JSON.stringify(replacement)}\n`);

    const lockInternals = store as unknown as {
      recoverClaimLock(lockPath: string, inspected: unknown): Promise<void>;
    };
    await lockInternals.recoverClaimLock(join(keyPath, 'lock'), {
      identity: `record:${original.claimId}`,
      claim: stale,
      ageMs: 60_000,
    });

    await expect(store.acquire({ key: 'github/org-repo/42', owner: 'worker-b', ttlMs: 60_000 })).resolves.toBeNull();
    await lease?.release();
  });

  it('fails within the gate timeout instead of removing an expired gate held by a live process', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const keyPath = join(stateRoot, 'claims', 'github', 'org-repo', '42');
    const gatePath = join(keyPath, '.operation-gate');
    await mkdir(gatePath, { recursive: true });
    await writeFile(join(gatePath, 'gate.json'), JSON.stringify({
      gateId: 'live-gate', owner: `${hostname()}:${process.pid}`, pid: process.pid, hostname: hostname(),
      createdAt: '2020-01-01T00:00:00.000Z', expiresAt: '2020-01-01T00:00:01.000Z',
    }));

    await expect(new FilesystemClaimLock(stateRoot, { gateTimeoutMs: 20, gateRetryMs: 1 }).acquire({
      key: 'github/org-repo/42', owner: 'worker', ttlMs: 60_000,
    })).rejects.toThrow('operation gate unavailable');
  });

  it('does not re-claim an expired lease without provider recovery approval', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const store = new FilesystemClaimLock(stateRoot);
    const first = await store.acquire({ key: 'github/org-repo/42', owner: 'worker-a', ttlMs: 60_000 });
    const claimPath = join(stateRoot, 'claims', 'github', 'org-repo', '42', 'lock', 'claim.json');
    const expired = { ...JSON.parse(await readFile(claimPath, 'utf8')), expiresAt: '2020-01-01T00:00:01.000Z' };
    await writeFile(claimPath, `${JSON.stringify(expired)}\n`);

    const recovery = vi.fn(async () => false);
    await expect(new FilesystemClaimLock(stateRoot, { onExpiredClaim: recovery }).acquire({
      key: 'github/org-repo/42', owner: 'worker-b', ttlMs: 60_000,
    })).resolves.toBeNull();
    expect(recovery).toHaveBeenCalledWith('github/org-repo/42', expect.objectContaining({ claimId: expired.claimId }));
    const approved = await new FilesystemClaimLock(stateRoot, { onExpiredClaim: async () => true }).acquire({
      key: 'github/org-repo/42', owner: 'worker-b', ttlMs: 60_000,
    });
    expect(approved).not.toBeNull();
    await approved?.release();
    await first?.release();
  });

  it('rejects a symbolic-link AFK state root before mutating it', async () => {
    const targetRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-target-'));
    const linkedRoot = `${targetRoot}-link`;
    stateRoots.push(targetRoot, linkedRoot);
    await symlink(targetRoot, linkedRoot, 'dir');

    await expect(new FilesystemClaimLock(linkedRoot).acquire({
      key: 'github/org-repo/42', owner: 'worker', ttlMs: 60_000,
    })).rejects.toThrow('non-symlink directory');
  });

  it('rejects a symbolic-link intermediate claims segment before writing outside state', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-state-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-outside-'));
    stateRoots.push(stateRoot, outsideRoot);
    await mkdir(join(stateRoot, 'claims'), { recursive: true });
    await symlink(outsideRoot, join(stateRoot, 'claims', 'github'), 'dir');

    await expect(new FilesystemClaimLock(stateRoot).acquire({
      key: 'github/org-repo/42', owner: 'worker', ttlMs: 60_000,
    })).rejects.toThrow('non-symlink directory');
    await expect(lstat(join(outsideRoot, 'org-repo'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('routes each expired lease recovery hook to its provider-qualified key', async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    const keys = ['github/org-repo/42', 'gitlab/group-project/9'];
    for (const key of keys) {
      const first = await new FilesystemClaimLock(stateRoot).acquire({ key, owner: 'worker-a', ttlMs: 60_000 });
      const claimPath = join(stateRoot, 'claims', ...key.split('/'), 'lock', 'claim.json');
      await writeFile(claimPath, `${JSON.stringify({ ...JSON.parse(await readFile(claimPath, 'utf8')), expiresAt: '2020-01-01T00:00:01.000Z' })}\n`);
      void first;
    }
    const routed: string[] = [];
    const store = new FilesystemClaimLock(stateRoot, { onExpiredClaim: async key => { routed.push(key); return false; } });
    for (const key of keys) await expect(store.acquire({ key, owner: 'worker-b', ttlMs: 60_000 })).resolves.toBeNull();
    expect(routed.sort()).toEqual([...keys].sort());
  });

  it('rejects a POSIX state root writable by group or other users', async () => {
    if (process.platform === 'win32') return;
    const stateRoot = await mkdtemp(join(tmpdir(), 'afk-claim-lock-'));
    stateRoots.push(stateRoot);
    await chmod(stateRoot, 0o777);

    await expect(new FilesystemClaimLock(stateRoot).acquire({
      key: 'github/org-repo/42', owner: 'worker', ttlMs: 60_000,
    })).rejects.toThrow('private AFK state directory');
  });
});
