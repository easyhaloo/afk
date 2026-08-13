import { lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir, hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ClaimLease,
  ClaimLockSnapshot,
  ExpiredClaim,
  FilesystemClaimLockOptions,
  FilesystemClaimRequest,
  GateSnapshot,
  StoredClaim,
  StoredOperationGate,
} from './claim-types';

export type {
  BacklogClaim,
  ClaimLease,
  FilesystemClaimLockOptions,
  FilesystemClaimRequest,
  ExpiredClaim,
} from './claim-types';

/**
 * A durable, single-host lease used by backlog providers that cannot make a
 * native conditional claim. It only guards a provider's claim critical
 * section; backlog data remains owned by that provider. On Windows, the
 * `AFK_STATE_DIR` (or explicit state root) must be a current-user-private,
 * trusted directory. Static symlinks are rejected, but Node.js does not offer
 * descriptor-relative ACL validation there, so same-user path replacement is
 * outside this lock's threat model.
 */
export class FilesystemClaimLock {
  private readonly stateRoot: string;
  private readonly claimsRoot: string;
  private readonly gateTimeoutMs: number;
  private readonly gateRetryMs: number;
  private readonly gateStaleMs: number;
  private readonly incompleteClaimGraceMs: number;
  private readonly onExpiredClaim?: FilesystemClaimLockOptions['onExpiredClaim'];

  /** `stateRoot` must be trusted local storage; see the class threat model. */
  constructor(stateRoot = defaultStateRoot(), options: FilesystemClaimLockOptions = {}) {
    this.stateRoot = resolve(stateRoot);
    this.claimsRoot = resolve(this.stateRoot, 'claims');
    this.gateTimeoutMs = positiveDuration(options.gateTimeoutMs ?? 5_000, 'gateTimeoutMs');
    this.gateRetryMs = positiveDuration(options.gateRetryMs ?? 10, 'gateRetryMs');
    this.gateStaleMs = positiveDuration(options.gateStaleMs ?? 30_000, 'gateStaleMs');
    this.incompleteClaimGraceMs = positiveDuration(options.incompleteClaimGraceMs ?? this.gateStaleMs, 'incompleteClaimGraceMs');
    this.onExpiredClaim = options.onExpiredClaim;
  }

  async acquire(request: FilesystemClaimRequest): Promise<ClaimLease | null> {
    const keyPath = this.keyPathFor(request.key);
    const lockPath = join(keyPath, 'lock');
    const claimId = randomUUID();
    const now = new Date();
    const claim = createStoredClaim(claimId, request.owner, request.ttlMs, now);

    await this.ensureTrustedStateDirectories(keyPath);
    const acquired = await this.withOperationGate(keyPath, async () => {
      const existing = await inspectClaimLock(lockPath);
      if (existing) {
        if (!isRecoverableClaimLock(existing, this.incompleteClaimGraceMs)) return false;
        if (existing.claim && !(await this.onExpiredClaim?.(request.key, existing.claim))) return false;
        await this.recoverClaimLock(lockPath, existing);
      }

      const ownerPath = claimOwnerPath(lockPath, claimId);
      await ensureTrustedChildDirectory(keyPath, '.claim-leases');
      await mkdir(ownerPath, { mode: 0o700 });
      await syncDirectory(dirname(ownerPath));

      try {
        await writeClaim(ownerPath, claim);
        await rename(ownerPath, lockPath);
        await syncDirectory(dirname(lockPath));
        return true;
      } catch (error) {
        await rm(ownerPath, { recursive: true, force: true });
        await syncDirectory(dirname(ownerPath));
        if (isTargetExists(error)) return false;
        throw error;
      }
    });
    if (!acquired) return null;

    let released = false;
    let pending = Promise.resolve();
    const serial = async <T>(operation: () => Promise<T>): Promise<T> => {
      const previous = pending;
      let complete!: () => void;
      pending = new Promise<void>(resolvePending => { complete = resolvePending; });
      await previous;
      try {
        return await operation();
      } finally {
        complete();
      }
    };

    return {
      claimId,
      heartbeat: async () => {
        if (released) throw new Error(`claim lease ${claimId} has been released`);
        await serial(async () => {
          await this.withOperationGate(keyPath, async () => {
            const stored = (await inspectClaimLock(lockPath))?.claim;
            if (!stored || stored.claimId !== claimId) {
              throw new Error(`claim lease ${claimId} is no longer held`);
            }
            await writeClaim(lockPath, createStoredClaim(claimId, stored.owner, stored.ttlMs, new Date(), stored.createdAt));
          });
        });
      },
      release: async () => {
        if (released) return;
        released = true;
        await serial(async () => {
          await this.withOperationGate(keyPath, async () => {
            const stored = (await inspectClaimLock(lockPath))?.claim;
            if (stored?.claimId !== claimId) return;
            await rm(lockPath, { recursive: true, force: true });
            await syncDirectory(dirname(lockPath));
          });
        });
      },
    };
  }

  private keyPathFor(key: string): string {
    const segments = key.split('/');
    if (segments.length < 3 || segments.some(segment => !segment || segment === '.' || segment === '..')) {
      throw new Error('claim key must contain provider, project, and backlog ID path segments');
    }

    const keyPath = join(this.claimsRoot, ...segments.map(encodeSegment));
    const keyRelative = relative(this.claimsRoot, keyPath);
    if (!keyRelative || keyRelative === '..' || keyRelative.startsWith(`..${sep}`) || isAbsolute(keyRelative)) {
      throw new Error('claim key must resolve below the claims state root');
    }
    return keyPath;
  }

  private async withOperationGate<T>(keyPath: string, operation: () => Promise<T>): Promise<T> {
    const gatePath = join(keyPath, '.operation-gate');
    const gate = await this.acquireOperationGate(gatePath);
    try {
      return await operation();
    } finally {
      await this.releaseOperationGate(gatePath, gate.gateId);
    }
  }

  private async ensureTrustedStateDirectories(keyPath: string): Promise<void> {
    await ensureTrustedDirectory(this.stateRoot);
    await ensureTrustedChildDirectory(this.stateRoot, 'claims');
    const relativeKey = relative(this.claimsRoot, keyPath);
    if (!relativeKey || relativeKey.startsWith(`..${sep}`) || isAbsolute(relativeKey)) {
      throw new Error(`AFK state path escapes claims root: ${keyPath}`);
    }
    let parent = this.claimsRoot;
    for (const segment of relativeKey.split(sep)) {
      await ensureTrustedChildDirectory(parent, segment);
      parent = join(parent, segment);
    }
  }

  private async acquireOperationGate(gatePath: string): Promise<StoredOperationGate> {
    const deadline = Date.now() + this.gateTimeoutMs;
    while (true) {
      const gate = createOperationGate(this.gateStaleMs);
      const ownerPath = gateOwnerPath(gatePath, gate.gateId);
      try {
        await ensureTrustedChildDirectory(dirname(gatePath), '.operation-gates');
        await mkdir(ownerPath, { mode: 0o700 });
        await syncDirectory(dirname(ownerPath));
        try {
          await writeGate(ownerPath, gate);
          await rename(ownerPath, gatePath);
          await syncDirectory(dirname(gatePath));
          return gate;
        } catch (error) {
          await rm(ownerPath, { recursive: true, force: true });
          await syncDirectory(dirname(ownerPath));
          throw error;
        }
      } catch (error: unknown) {
        if (!isTargetExists(error)) throw error;
        await this.recoverExpiredDeadGate(gatePath);
        if (Date.now() >= deadline) {
          throw new Error(`claim operation gate unavailable after ${this.gateTimeoutMs}ms: ${gatePath}`);
        }
        await delay(this.gateRetryMs);
      }
    }
  }

  private async recoverExpiredDeadGate(gatePath: string): Promise<void> {
    const inspected = await inspectGate(gatePath);
    if (!inspected || !isRecoverableGate(inspected, this.gateStaleMs)) return;

    const recoveryPath = join(dirname(gatePath), `.operation-gate-recovery-${encodeSegment(inspected.identity)}`);
    try {
      await mkdir(recoveryPath, { mode: 0o700 });
      await syncDirectory(dirname(recoveryPath));
    } catch (error: unknown) {
      if (isAlreadyExists(error) || isNotFound(error)) return;
      throw error;
    }
    try {
      const current = await inspectGate(gatePath);
      if (!current || current.identity !== inspected.identity || !isRecoverableGate(current, this.gateStaleMs)) return;

      const tombstonePath = join(dirname(gatePath), `.operation-gate-recovered-${randomUUID()}`);
      try {
        await rename(gatePath, tombstonePath);
      } catch (error: unknown) {
        if (isNotFound(error)) return;
        throw error;
      }
      await rm(tombstonePath, { recursive: true, force: true });
      await syncDirectory(dirname(gatePath));
    } finally {
      await rm(recoveryPath, { recursive: true, force: true });
      await syncDirectory(dirname(recoveryPath));
    }
  }

  private async recoverClaimLock(lockPath: string, inspected: ClaimLockSnapshot): Promise<void> {
    const current = await inspectClaimLock(lockPath);
    if (!current || current.identity !== inspected.identity || !isRecoverableClaimLock(current, this.incompleteClaimGraceMs)) return;

    const tombstonePath = join(dirname(lockPath), `.claim-lock-recovered-${randomUUID()}`);
    try {
      await rename(lockPath, tombstonePath);
    } catch (error: unknown) {
      if (isNotFound(error)) return;
      throw error;
    }
    await rm(tombstonePath, { recursive: true, force: true });
    await syncDirectory(dirname(lockPath));
  }

  private async releaseOperationGate(gatePath: string, gateId: string): Promise<void> {
    const current = (await inspectGate(gatePath))?.gate;
    if (current?.gateId !== gateId) return;
    await rm(gatePath, { recursive: true, force: true });
    await syncDirectory(dirname(gatePath));
  }
}

function defaultStateRoot(): string {
  return process.env.AFK_STATE_DIR ?? join(homedir(), '.afk', 'state');
}

function createStoredClaim(claimId: string, owner: string, ttlMs: number, now: Date, createdAt = now.toISOString()): StoredClaim {
  if (!owner) throw new Error('claim owner is required');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('claim ttlMs must be a positive number');
  return {
    claimId,
    owner,
    createdAt,
    heartbeatAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    ttlMs,
  };
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replaceAll('.', '%2E');
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function isTargetExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'EEXIST' || error.code === 'ENOTEMPTY');
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function createOperationGate(staleMs: number): StoredOperationGate {
  const now = new Date();
  const host = hostname();
  return {
    gateId: randomUUID(),
    owner: `${host}:${process.pid}`,
    pid: process.pid,
    hostname: host,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + staleMs).toISOString(),
  };
}

function gateOwnerPath(gatePath: string, gateId: string): string {
  return join(dirname(gatePath), '.operation-gates', gateId);
}

function claimOwnerPath(lockPath: string, claimId: string): string {
  return join(dirname(lockPath), '.claim-leases', claimId);
}

function isGateOwnerAlive(gate: StoredOperationGate): boolean {
  if (gate.hostname !== hostname() || !Number.isSafeInteger(gate.pid) || gate.pid <= 0) return true;
  try {
    process.kill(gate.pid, 0);
    return true;
  } catch (error: unknown) {
    return !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH');
  }
}

async function inspectGate(gatePath: string): Promise<GateSnapshot | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(gatePath);
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
  assertTrustedStateDirectory(metadata, gatePath);
  const gate = await readGate(gatePath);
  if (gate) {
    return {
      identity: `record:${gate.gateId}`,
      gate,
      ageMs: Math.max(0, Date.now() - Date.parse(gate.createdAt)),
    };
  }
  return {
    identity: `empty:${metadata.dev}:${metadata.ino}:${Math.floor(metadata.mtimeMs)}`,
    gate: null,
    ageMs: Math.max(0, Date.now() - metadata.mtimeMs),
  };
}

async function inspectClaimLock(lockPath: string): Promise<ClaimLockSnapshot | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(lockPath);
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
  assertTrustedStateDirectory(metadata, lockPath);
  const claim = await readClaim(lockPath);
  if (claim) {
    return {
      identity: `record:${claim.claimId}`,
      claim,
      ageMs: Math.max(0, Date.now() - Date.parse(claim.createdAt)),
    };
  }
  return {
    identity: `empty:${metadata.dev}:${metadata.ino}:${Math.floor(metadata.mtimeMs)}`,
    claim: null,
    ageMs: Math.max(0, Date.now() - metadata.mtimeMs),
  };
}

function isRecoverableGate(snapshot: GateSnapshot, staleMs: number): boolean {
  if (snapshot.gate) {
    return Date.parse(snapshot.gate.expiresAt) <= Date.now() && !isGateOwnerAlive(snapshot.gate);
  }
  return snapshot.ageMs >= staleMs;
}

function isRecoverableClaimLock(snapshot: ClaimLockSnapshot, incompleteGraceMs: number): boolean {
  return snapshot.claim
    ? Date.parse(snapshot.claim.expiresAt) <= Date.now()
    : snapshot.ageMs >= incompleteGraceMs;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms));
}

async function ensureTrustedDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    assertTrustedStateDirectory(metadata, path);
    return;
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  await syncDirectory(dirname(path));
  const metadata = await lstat(path);
  assertTrustedStateDirectory(metadata, path);
}

async function ensureTrustedChildDirectory(parent: string, child: string): Promise<void> {
  if (!child || child === '.' || child === '..' || child.includes('/') || child.includes('\\')) {
    throw new Error(`invalid AFK state path segment: ${child}`);
  }
  const path = join(parent, child);
  try {
    const metadata = await lstat(path);
    assertTrustedStateDirectory(metadata, path);
    return;
  } catch (error: unknown) {
    if (!isNotFound(error)) throw error;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!isAlreadyExists(error)) throw error;
  }
  await syncDirectory(parent);
  const metadata = await lstat(path);
  assertTrustedStateDirectory(metadata, path);
}

function assertTrustedStateDirectory(metadata: Awaited<ReturnType<typeof lstat>>, path: string): void {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`AFK state path must be a non-symlink directory: ${path}`);
  }
  if (process.platform === 'win32') return;
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && metadata.uid !== currentUid) {
    throw new Error(`AFK state path must be owned by the current user: ${path}`);
  }
  if ((Number(metadata.mode) & 0o022) !== 0) {
    throw new Error(`AFK state path must be a private AFK state directory: ${path}`);
  }
}

async function syncDirectory(path: string): Promise<void> {
  let directory: Awaited<ReturnType<typeof open>> | undefined;
  try {
    directory = await open(path, 'r');
    await directory.sync();
  } catch (error: unknown) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  } finally {
    await directory?.close();
  }
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error.code === 'EINVAL' || error.code === 'EPERM' || error.code === 'ENOTSUP' || error.code === 'EOPNOTSUPP');
}

async function writeClaim(lockPath: string, claim: StoredClaim): Promise<void> {
  await writeJsonAtomically(lockPath, 'claim.json', claim);
}

async function writeGate(gatePath: string, gate: StoredOperationGate): Promise<void> {
  await writeJsonAtomically(gatePath, 'gate.json', gate);
}

async function writeJsonAtomically(directory: string, filename: string, value: object): Promise<void> {
  const temporaryPath = join(directory, `.${filename}-${randomUUID()}.tmp`);
  const file = await open(temporaryPath, 'w', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporaryPath, join(directory, filename));
  await syncDirectory(directory);
}

async function readClaim(lockPath: string): Promise<StoredClaim | null> {
  try {
    return JSON.parse(await readFile(join(lockPath, 'claim.json'), 'utf8')) as StoredClaim;
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

async function readGate(gatePath: string): Promise<StoredOperationGate | null> {
  try {
    return JSON.parse(await readFile(join(gatePath, 'gate.json'), 'utf8')) as StoredOperationGate;
  } catch (error: unknown) {
    if (isNotFound(error)) return null;
    throw error;
  }
}
