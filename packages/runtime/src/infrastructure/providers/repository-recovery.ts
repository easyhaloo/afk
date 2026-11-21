import { constants, promises as fs } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';
import { repositoryClaimIds, repositoryLeaseKey } from '../git/repository-lease.js';
import { openSqlite, transaction, type SqliteDatabase } from '../storage/sqlite.js';
import { executeCommand } from './dependencies.js';

const inodeSchema = z.object({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative() }).strict();
const locationSchema = inodeSchema.extend({ path: z.string().min(1) }).strict();
const removalSchema = z.object({ common: locationSchema, administration: locationSchema,
  pointer: inodeSchema.extend({ content: z.string().max(4096) }).strict() }).strict();
const allocationSchema = z.object({ id: z.string().uuid(), repository: z.object({ url: z.string().min(1), ref: z.string().optional() }).strict(),
  runId: z.string().min(1), path: z.string().min(1) }).strict();
const recordSchema = z.object({ version: z.literal(1), allocation: allocationSchema, workspaceRoot: z.string(), rootIdentity: inodeSchema,
  leaseKey: z.string().min(1), configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
  owner: z.object({ pid: z.number().int().positive(), host: z.string().min(1), claims: z.array(z.string().uuid()) }).strict(),
  phase: z.enum(['intent', 'reserved', 'owned', 'retained', 'recovering', 'removing', 'closed']), directory: inodeSchema.optional(),
  marker: z.object({ dev: z.number().int().nonnegative(), ino: z.number().int().nonnegative(), content: z.string().max(4096) }).strict().optional(),
  safeCommit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
  removal: removalSchema.optional(), retryable: z.boolean().optional(),
  reservationRemoval: z.object({ parent: inodeSchema, witness: z.string().min(1) }).strict().optional(),
}).strict();
export type RepositoryRecoveryRecord = z.infer<typeof recordSchema>;
export type RepositoryRecoveryAllocation = RepositoryRecoveryRecord['allocation'];

function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function same(first: unknown, second: unknown): boolean { return JSON.stringify(first) === JSON.stringify(second); }
function inode(metadata: { dev: number; ino: number }) { return { dev: metadata.dev, ino: metadata.ino }; }

export class RepositoryRecoveryJournal {
  private root?: string;

  constructor(private readonly configuredRoot: string, private readonly leaseStateRoot?: string) {
    if (!isAbsolute(configuredRoot) || resolve(configuredRoot) !== configuredRoot) throw new Error('Recovery root must be canonical');
  }

  get workspaceRoot(): string { return this.root ?? this.configuredRoot; }
  get directory(): string { return join(this.workspaceRoot, '.afk-repository-recovery'); }

  async begin(allocation: RepositoryRecoveryAllocation, leaseKey: string, configurationDigest: string): Promise<void> {
    await this.canonicalize();
    const metadata = await fs.lstat(this.workspaceRoot);
    const record = recordSchema.parse({ version: 1, allocation, workspaceRoot: this.workspaceRoot, rootIdentity: inode(metadata), leaseKey, configurationDigest,
      owner: { pid: process.pid, host: hostname(), claims: [...repositoryClaimIds()] }, phase: 'intent' });
    this.bind(record);
    await this.use(database => { database.prepare('INSERT INTO allocations (id, payload) VALUES (?, ?)').run(allocation.id, JSON.stringify(record)); });
  }

  async list(): Promise<RepositoryRecoveryRecord[]> {
    const root = await fs.lstat(this.configuredRoot).catch(error => { if (absent(error)) return undefined; throw error; });
    if (!root) return [];
    await this.canonicalize();
    const directory = await fs.lstat(this.directory).catch(error => { if (absent(error)) return undefined; throw error; });
    if (!directory) return [];
    const records = await this.use(database => database.prepare('SELECT payload FROM allocations ORDER BY id').all()
      .map(row => this.parse(row.payload)).filter(record => record.phase !== 'closed' || record.reservationRemoval));
    const pending = await Promise.all(records.map(async record => {
      if (record.phase !== 'closed') return record;
      await this.reservationParent(record);
      const original = await fs.lstat(record.allocation.path).catch(error => { if (absent(error)) return undefined; throw error; });
      const witness = await fs.lstat(record.reservationRemoval!.witness).catch(error => { if (absent(error)) return undefined; throw error; });
      if (original || !witness || !witness.isDirectory() || witness.isSymbolicLink() || !same(inode(witness), record.directory)
        || (await fs.readdir(record.reservationRemoval!.witness)).length) return record;
      return undefined;
    }));
    return pending.filter((record): record is RepositoryRecoveryRecord => record !== undefined);
  }

  async get(id: string): Promise<RepositoryRecoveryRecord> {
    z.string().uuid().parse(id);
    return this.use(database => {
      const row = database.prepare('SELECT payload FROM allocations WHERE id = ?').get(id);
      if (!row) throw new Error('Unknown repository recovery allocation');
      const record = this.parse(row.payload);
      if (record.allocation.id !== id) throw new Error('Repository recovery identity mismatch');
      return record;
    });
  }

  async reserved(id: string): Promise<void> {
    const record = await this.get(id);
    const directory = await fs.lstat(record.allocation.path);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (await fs.readdir(record.allocation.path)).length) throw new Error('Unknown reserved repository directory');
    await this.change(id, current => ({ ...current, directory: inode(directory), phase: 'reserved' }));
  }

  async owned(id: string): Promise<void> {
    const record = await this.get(id);
    const directory = await fs.lstat(record.allocation.path);
    const marker = await fs.lstat(join(record.allocation.path, '.git'));
    if (!directory.isDirectory() || directory.isSymbolicLink() || !same(record.directory, inode(directory)) || !marker.isFile() || marker.isSymbolicLink()) {
      throw new Error('Repository allocation identity changed');
    }
    const safeCommit = (await executeCommand({ command: 'git', args: ['rev-parse', '--verify', 'HEAD'], cwd: record.allocation.path })).stdout.trim();
    const content = await fs.readFile(join(record.allocation.path, '.git'), 'utf8');
    await this.change(id, current => ({ ...current, marker: { ...inode(marker), content }, safeCommit, phase: 'owned' }));
  }

  async retain(id: string): Promise<void> {
    await this.change(id, record => ({ ...record, phase: record.phase === 'removing' ? 'removing' : 'retained', retryable: true }));
  }
  async bindOwner(id: string): Promise<void> {
    await this.change(id, record => ({ ...record, owner: { pid: process.pid, host: hostname(), claims: [...repositoryClaimIds()] }, retryable: false }), true);
  }
  async claimRecovery(id: string): Promise<void> {
    const claims = [...repositoryClaimIds()];
    if (!claims.length) throw new Error('Repository recovery has no current lease generation');
    await this.change(id, record => ({ ...record, phase: record.phase === 'removing' ? 'removing' : 'recovering',
      owner: { pid: process.pid, host: hostname(), claims }, retryable: false }));
  }
  async removing(id: string): Promise<void> {
    const record = await this.get(id);
    let removal = record.removal;
    if (record.marker) {
      await this.assertIdentity(record);
      const path = record.allocation.path;
      const common = await fs.realpath(resolve(path, (await executeCommand({ command: 'git', args: ['rev-parse', '--git-common-dir'], cwd: path })).stdout.trim()));
      const administration = await fs.realpath((await executeCommand({ command: 'git', args: ['rev-parse', '--absolute-git-dir'], cwd: path })).stdout.trim());
      if (dirname(administration) !== join(common, 'worktrees')) throw new Error('Repository recovery registration is not a linked worktree');
      const commonMetadata = await fs.lstat(common);
      const administrationMetadata = await fs.lstat(administration);
      const pointer = await fs.lstat(join(administration, 'gitdir'));
      const content = await fs.readFile(join(administration, 'gitdir'), 'utf8');
      if (!commonMetadata.isDirectory() || !administrationMetadata.isDirectory() || !pointer.isFile() || pointer.isSymbolicLink()
        || resolve(administration, content.trim()) !== join(path, '.git')) throw new Error('Repository recovery registration changed');
      const captured = { common: { ...inode(commonMetadata), path: common }, administration: { ...inode(administrationMetadata), path: administration },
        pointer: { ...inode(pointer), content } };
      if (removal && !same(removal, captured)) throw new Error('Repository recovery removal registration changed');
      removal = captured;
    }
    await this.change(id, current => ({ ...current, phase: 'removing', ...(removal ? { removal } : {}) }));
  }
  async close(id: string): Promise<void> { await this.change(id, record => ({ ...record, phase: 'closed' })); }
  async published(id: string, safeCommit: string): Promise<void> { await this.change(id, record => ({ ...record, safeCommit })); }

  async removeReservation(id: string): Promise<void> {
    const record = await this.get(id);
    if (record.marker || !record.directory) throw new Error('Repository recovery reservation ownership is unknown');
    await this.assertIdentity(record);
    if ((await fs.readdir(record.allocation.path)).length) throw new Error('Repository recovery allocation ownership is unknown');
    const parent = await this.reservationParent(record);
    const reservationRemoval = { parent: inode(parent), witness: join(this.directory, `reservation-${id}`) };
    if (record.reservationRemoval && !same(record.reservationRemoval, reservationRemoval)) throw new Error('Repository recovery reservation parent changed');
    const target = await fs.lstat(reservationRemoval.witness).catch(error => { if (absent(error)) return undefined; throw error; });
    if (target) throw new Error('Repository recovery reservation witness already exists');
    await this.change(id, current => ({ ...current, phase: 'removing', reservationRemoval }));
    await this.assertIdentity(record);
    await this.reservationParent({ ...record, reservationRemoval });
    if ((await fs.readdir(record.allocation.path)).length) throw new Error('Repository recovery allocation ownership is unknown');
    await fs.rename(record.allocation.path, reservationRemoval.witness);
    await this.settleReservation(id);
  }

  async settleReservation(id: string): Promise<void> {
    let record = await this.get(id);
    const witness = await this.reservationWitness(record);
    if (!witness) throw new Error('Repository recovery reservation witness disappeared');
    if (record.phase !== 'closed') {
      await this.syncDirectory(this.workspaceRoot);
      await this.syncDirectory(this.directory);
      await this.close(id);
      record = await this.get(id);
    }
    if (!await this.reservationWitness(record)) throw new Error('Repository recovery reservation witness disappeared');
  }

  private async reservationParent(record: RepositoryRecoveryRecord) {
    await this.assertRoot(record);
    const parent = await fs.lstat(this.directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || await fs.realpath(this.directory) !== this.directory
      || (process.platform !== 'win32' && ((parent.mode & 0o077) !== 0 || (process.getuid && parent.uid !== process.getuid())))
      || (record.reservationRemoval && !same(record.reservationRemoval.parent, inode(parent)))) throw new Error('Repository recovery reservation parent changed');
    return parent;
  }

  private async reservationWitness(record: RepositoryRecoveryRecord) {
    if (!record.reservationRemoval || record.marker || !record.directory) throw new Error('Repository recovery has no bound reservation witness');
    await this.reservationParent(record);
    const original = await fs.lstat(record.allocation.path).catch(error => { if (absent(error)) return undefined; throw error; });
    if (original) throw new Error('Repository recovery reservation original path reappeared');
    const witness = await fs.lstat(record.reservationRemoval.witness).catch(error => { if (absent(error)) return undefined; throw error; });
    if (witness && (!witness.isDirectory() || witness.isSymbolicLink() || !same(inode(witness), record.directory)
      || (await fs.readdir(record.reservationRemoval.witness)).length)) throw new Error('Repository recovery reservation witness changed');
    await this.reservationParent(record);
    return witness;
  }

  private async syncDirectory(path: string): Promise<void> {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async assertIdentity(record: RepositoryRecoveryRecord): Promise<void> {
    await this.assertRoot(record);
    const directory = await fs.lstat(record.allocation.path);
    if (!record.directory || !directory.isDirectory() || directory.isSymbolicLink() || !same(inode(directory), record.directory)
      || await fs.realpath(record.allocation.path) !== record.allocation.path) throw new Error('Repository recovery directory changed');
    if (record.marker) {
      const marker = await fs.lstat(join(record.allocation.path, '.git'));
      if (!marker.isFile() || marker.isSymbolicLink() || !same(inode(marker), inode(record.marker))
        || await fs.readFile(join(record.allocation.path, '.git'), 'utf8') !== record.marker.content) throw new Error('Repository recovery git identity changed');
    }
  }

  async assertRemovalComplete(record: RepositoryRecoveryRecord): Promise<void> {
    await this.assertRoot(record);
    if (!record.removal || !record.directory || !record.marker || !record.safeCommit) throw new Error('Repository recovery has no bound removal registration');
    const { common, administration } = record.removal;
    const metadata = await fs.lstat(common.path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !same(inode(metadata), inode(common))
      || await fs.realpath(common.path) !== common.path || dirname(administration.path) !== join(common.path, 'worktrees')) {
      throw new Error('Repository recovery Store identity changed');
    }
    const registrations = await fs.lstat(dirname(administration.path)).catch(error => { if (absent(error)) return undefined; throw error; });
    if (registrations && (!registrations.isDirectory() || registrations.isSymbolicLink())) throw new Error('Repository recovery registration root changed');
    const entries = (await executeCommand({ command: 'git', args: ['worktree', 'list', '--porcelain', '-z'], cwd: common.path })).stdout.split('\0');
    for (const entry of entries.filter(entry => entry.startsWith('worktree '))) {
      const path = entry.slice(9);
      if (path === record.allocation.path || path.startsWith(`${record.allocation.path}${sep}`)) throw new Error('Repository recovery checkout is still registered');
      const checkout = await fs.lstat(path).catch(error => { if (absent(error)) return undefined; throw error; });
      if (checkout && same(inode(checkout), record.directory)) throw new Error('Repository recovery checkout was moved');
    }
    for (const path of [record.allocation.path, administration.path]) {
      const entry = await fs.lstat(path).catch(error => { if (absent(error)) return undefined; throw error; });
      if (entry) throw new Error('Repository recovery removal is incomplete');
    }
    await this.assertRoot(record);
  }

  private async assertRoot(record: RepositoryRecoveryRecord): Promise<void> {
    this.bind(record);
    const root = await fs.lstat(this.workspaceRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || !same(inode(root), record.rootIdentity)
      || await fs.realpath(this.workspaceRoot) !== this.workspaceRoot) throw new Error('Repository recovery root changed');
  }

  async allowRecovery(record: RepositoryRecoveryRecord): Promise<void> {
    if (record.owner.host !== hostname()) throw new Error('Unknown repository recovery owner host');
    let dead = false;
    try { process.kill(record.owner.pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; dead = true; }
    if (!dead && record.phase !== 'retained' && !(record.phase === 'removing' && record.retryable === true)
      && !(record.phase === 'closed' && record.reservationRemoval)) throw new Error('Repository recovery owner is active');
    if (!record.owner.claims.length) throw new Error('Repository recovery has no bound lease generation');
    const key = repositoryLeaseKey(record.leaseKey);
    const locks = new FilesystemClaimLock(this.leaseStateRoot, { onExpiredClaim: async (_key, claim) => {
      if (!dead || !record.owner.claims.includes(claim.claimId)) return false;
      const owner: unknown = JSON.parse(claim.owner);
      const parsed = z.object({ pid: z.number(), host: z.string(), recovery: z.literal('manual') }).strict().safeParse(owner);
      return parsed.success && parsed.data.pid === record.owner.pid && parsed.data.host === record.owner.host;
    } });
    const claim = await locks.inspect(key);
    if (!claim) return;
    if (!dead || !record.owner.claims.includes(claim.claimId) || Date.parse(claim.expiresAt) > Date.now()) throw new Error('Repository recovery lease is active or unknown');
    const recovered = await locks.acquire({ key, owner: JSON.stringify({ pid: process.pid, host: hostname(), recovery: 'manual' }), ttlMs: 60_000 });
    if (!recovered) throw new Error('Repository recovery lease changed');
    await recovered.release();
  }

  private bind(record: RepositoryRecoveryRecord): void {
    if (record.workspaceRoot !== this.workspaceRoot || record.allocation.path !== join(this.workspaceRoot, record.allocation.id)) {
      throw new Error('Repository recovery allocation is outside its bound root');
    }
    if (record.reservationRemoval && record.reservationRemoval.witness !== join(this.directory, `reservation-${record.allocation.id}`)) {
      throw new Error('Repository recovery reservation witness is outside its bound root');
    }
  }

  private parse(payload: unknown): RepositoryRecoveryRecord {
    if (typeof payload !== 'string' || Buffer.byteLength(payload) > 16384) throw new Error('Invalid repository recovery record');
    const record = recordSchema.parse(JSON.parse(payload));
    this.bind(record);
    return record;
  }

  private async change(id: string, change: (record: RepositoryRecoveryRecord) => RepositoryRecoveryRecord, allowClosed = false): Promise<void> {
    await this.use(database => transaction(database, () => {
      const row = database.prepare('SELECT payload FROM allocations WHERE id = ?').get(id);
      if (!row) throw new Error('Unknown repository recovery allocation');
      const record = this.parse(row.payload);
      if (record.allocation.id !== id || (record.phase === 'closed' && !allowClosed)) throw new Error('Repository recovery record is already closed or mismatched');
      const updated = recordSchema.parse(change(record));
      this.bind(updated);
      database.prepare('UPDATE allocations SET payload = ? WHERE id = ?').run(JSON.stringify(updated), id);
    }));
  }

  private async use<Result>(operation: (database: SqliteDatabase) => Result): Promise<Result> {
    await this.canonicalize();
    const root = await fs.lstat(this.workspaceRoot);
    if (!root.isDirectory() || root.isSymbolicLink() || await fs.realpath(this.workspaceRoot) !== this.workspaceRoot) throw new Error('Repository recovery requires a canonical root');
    await fs.mkdir(this.directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    const metadata = await fs.lstat(this.directory);
    const trusted = (entry: { uid: number; mode: number }) => process.platform === 'win32'
      || ((process.getuid?.() === undefined || entry.uid === process.getuid()) && (entry.mode & 0o077) === 0);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || !trusted(metadata)) throw new Error('Repository recovery directory is not private');
    const file = join(this.directory, 'allocations.sqlite');
    const created = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      .catch(error => { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined; throw error; });
    if (created) await created.close();
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      for (let attempt = 0; ; attempt += 1) {
        const handle = await fs.open(file + suffix, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
          if (suffix && absent(error)) return undefined;
          if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('Repository recovery storage is not private');
          throw error;
        });
        if (!handle) break;
        let unlinked = false;
        try {
          const entry = await handle.stat();
          if (!entry.isFile() || !trusted(entry) || entry.nlink > 1) throw new Error('Repository recovery storage is not private');
          if (entry.nlink === 1) break;
          const current = await fs.lstat(file + suffix).catch(error => { if (absent(error)) return undefined; throw error; });
          if (current && (!current.isFile() || current.isSymbolicLink() || !trusted(current) || current.nlink > 1)) {
            throw new Error('Repository recovery storage is not private');
          }
          unlinked = Boolean(suffix) && entry.nlink === 0;
        } finally { await handle.close(); }
        if (!unlinked) throw new Error('Repository recovery storage is not private');
        if (attempt >= 7) throw new Error('Repository recovery storage is busy: sidecar changed during validation');
      }
    }
    const database = openSqlite({ file, durability: 'FULL', schema: 'CREATE TABLE allocations (id TEXT PRIMARY KEY, payload TEXT NOT NULL);' });
    try {
      const result = operation(database);
      const handle = await fs.open(this.directory, constants.O_RDONLY);
      try { await handle.sync(); } finally { await handle.close(); }
      const parent = await fs.open(this.workspaceRoot, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      return result;
    } finally { database.close(); }
  }

  private async canonicalize(): Promise<void> {
    const metadata = await fs.lstat(this.configuredRoot);
    const root = await fs.realpath(this.configuredRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (this.root !== undefined && root !== this.root)) throw new Error('Repository recovery root changed');
    this.root = root;
  }
}
