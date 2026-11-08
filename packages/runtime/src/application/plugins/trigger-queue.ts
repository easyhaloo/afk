import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, resolve } from 'node:path';
import { openSqlite, transaction, type SqliteDatabase } from '../../infrastructure/storage/sqlite.js';

export interface TriggerQueueOptions {
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  /** Total retained records across all states; defaults to 10,000. */
  readonly maxRecords?: number;
  /** Total retained UTF-8 payload bytes; defaults to 64 MiB. Record metadata is bounded by maxRecords. */
  readonly maxBytes?: number;
  /** Minimum dedupe window after successful delivery, default seven days. Only explicit pruneDelivered() removes expired IDs. */
  readonly deliveredRetentionMs?: number;
}

export interface TriggerDeliveryStatus {
  readonly deliveryId: string;
  readonly providerId: string;
  readonly status: 'pending' | 'processing' | 'delivered' | 'failed';
  readonly attempts: number;
  readonly receivedAt: number;
  readonly nextAttemptAt: number;
}

export class TriggerDeliveryConflict extends Error {}
export class InvalidTriggerDelivery extends Error {}
export class TriggerQueueFull extends Error {}

const deliveryContext = new AsyncLocalStorage<string>();

export function currentTriggerDeliveryId(): string | undefined {
  return deliveryContext.getStore();
}

const statusColumns = 'deliveryId, providerId, status, attempts, receivedAt, nextAttemptAt';
const schema = `
  CREATE TABLE trigger_deliveries (
    deliveryId TEXT PRIMARY KEY,
    providerId TEXT NOT NULL,
    body TEXT NOT NULL,
    digest TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'delivered', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    receivedAt INTEGER NOT NULL,
    nextAttemptAt INTEGER NOT NULL,
    bodyBytes INTEGER NOT NULL,
    deliveredAt INTEGER
  );
  CREATE INDEX trigger_deliveries_pending ON trigger_deliveries(status, nextAttemptAt);
  CREATE TABLE trigger_queue_owner (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), pid INTEGER NOT NULL, host TEXT NOT NULL, nonce TEXT NOT NULL);
`;

function privateFile(file: string): void {
  const descriptor = openSync(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error('Trigger queue must use a regular private file');
    fchmodSync(descriptor, 0o600);
  } finally { closeSync(descriptor); }
}

function ownerIsDead(owner: { [column: string]: unknown }): boolean {
  if (owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1) return false;
  try { process.kill(Number(owner.pid), 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function assertOwnerAvailable(database: SqliteDatabase): void {
  const owner = database.prepare('SELECT * FROM trigger_queue_owner WHERE singleton = 1').get();
  if (owner && !ownerIsDead(owner)) throw new Error('Trigger queue is already owned by a live or unverifiable listener');
}

export class DurableTriggerQueue {
  private readonly database: SqliteDatabase;
  private readonly nonce = randomUUID();
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly maxRecords: number;
  private readonly maxBytes: number;
  private readonly deliveredRetentionMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private closing?: Promise<void>;
  private started = false;
  private faulted = false;

  constructor(
    file: string,
    private readonly dispatch: (delivery: { readonly deliveryId: string; readonly providerId: string; readonly body: string }) => Promise<void>,
    options: TriggerQueueOptions = {},
    private readonly onError: () => void = () => {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 5;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.maxRecords = options.maxRecords ?? 10_000;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.deliveredRetentionMs = options.deliveredRetentionMs ?? 7 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 100
      || !Number.isSafeInteger(this.retryDelayMs) || this.retryDelayMs < 1 || this.retryDelayMs > 60_000) throw new Error('Invalid trigger queue retry limits');
    if ([this.maxRecords, this.maxBytes, this.deliveredRetentionMs].some(value => !Number.isSafeInteger(value) || value < 1)) throw new Error('Invalid trigger queue storage limits');
    if (!file.trim() || file === ':memory:') throw new Error('Trigger queue requires a durable file path');
    const path = resolve(file);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const directory = lstatSync(dirname(path));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0) throw new Error('Trigger queue directory must be private (0700)');
    privateFile(path);
    for (const suffix of ['-wal', '-shm']) {
      try { lstatSync(path + suffix); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      privateFile(path + suffix);
    }
    this.database = openSqlite({ file: path, schema, durability: 'FULL', version: 2, migrations: [{
      from: 1, to: 2, migrate: database => {
        assertOwnerAvailable(database);
        database.exec('ALTER TABLE trigger_deliveries ADD COLUMN bodyBytes INTEGER NOT NULL DEFAULT 0; ALTER TABLE trigger_deliveries ADD COLUMN deliveredAt INTEGER');
        database.exec('UPDATE trigger_deliveries SET bodyBytes = length(CAST(body AS BLOB))');
        database.prepare("UPDATE trigger_deliveries SET deliveredAt = ? WHERE status = 'delivered'").run(Date.now());
      },
    }] });
    try {
      transaction(this.database, () => {
        assertOwnerAvailable(this.database);
        this.database.prepare('INSERT OR REPLACE INTO trigger_queue_owner VALUES (1, ?, ?, ?)').run(process.pid, hostname(), this.nonce);
        this.database.prepare("UPDATE trigger_deliveries SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END WHERE status = 'processing'").run(this.maxAttempts);
      });
    } catch (error) { this.database.close(); throw error; }
  }

  enqueue(providerId: string, body: string, sourceId?: string): TriggerDeliveryStatus & { readonly duplicate: boolean } {
    this.assertWritable();
    const bodyBytes = Buffer.byteLength(body);
    if (providerId.length > 200 || !/^[a-z][a-z0-9.-]*$/.test(providerId) || bodyBytes > 1024 * 1024
      || (sourceId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(sourceId))) throw new InvalidTriggerDelivery('Invalid trigger delivery');
    const digest = createHash('sha256').update(body).digest('hex');
    const deliveryId = createHash('sha256').update(`${providerId}\0${sourceId === undefined ? `body:${digest}` : `id:${sourceId}`}`).digest('hex');
    const receipt = transaction(this.database, () => {
      const existing = this.database.prepare('SELECT digest FROM trigger_deliveries WHERE deliveryId = ?').get(deliveryId);
      if (existing && existing.digest !== digest) throw new TriggerDeliveryConflict('Delivery id was already used for another payload');
      if (!existing) {
        const usage = this.storageUsage();
        if (usage.records >= this.maxRecords || bodyBytes > this.maxBytes - usage.bytes) throw new TriggerQueueFull('Trigger queue is full');
        const now = Date.now();
        this.database.prepare("INSERT INTO trigger_deliveries (deliveryId, providerId, body, digest, status, attempts, receivedAt, nextAttemptAt, bodyBytes) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)").run(deliveryId, providerId, body, digest, now, now, bodyBytes);
      }
      return { ...this.status(deliveryId)[0], duplicate: Boolean(existing) };
    });
    this.wake();
    return receipt;
  }

  status(deliveryId?: string, options: { offset?: number; limit?: number } = {}): readonly TriggerDeliveryStatus[] {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('Invalid delivery pagination');
    const rows = deliveryId === undefined
      ? this.database.prepare(`SELECT ${statusColumns} FROM trigger_deliveries ORDER BY receivedAt DESC, deliveryId LIMIT ? OFFSET ?`).all(limit, offset)
      : this.database.prepare(`SELECT ${statusColumns} FROM trigger_deliveries WHERE deliveryId = ?`).all(deliveryId);
    return rows as unknown as TriggerDeliveryStatus[];
  }

  storageUsage(): { records: number; bytes: number; maxRecords: number; maxBytes: number } {
    const row = this.database.prepare('SELECT COUNT(*) AS records, COALESCE(SUM(bodyBytes), 0) AS bytes FROM trigger_deliveries').get()!;
    return { records: Number(row.records), bytes: Number(row.bytes), maxRecords: this.maxRecords, maxBytes: this.maxBytes };
  }

  /** Deletes only delivered records past deliveredRetentionMs. Pruned IDs can be accepted and dispatched again; pending/failed records remain. */
  pruneDelivered(): number {
    this.assertWritable();
    return transaction(this.database, () => {
      this.database.prepare("DELETE FROM trigger_deliveries WHERE status = 'delivered' AND deliveredAt <= ?").run(Date.now() - this.deliveredRetentionMs);
      return Number(this.database.prepare('SELECT changes() AS count').get()?.count);
    });
  }

  replay(deliveryId: string): TriggerDeliveryStatus {
    this.assertWritable();
    const receipt = transaction(this.database, () => {
      const delivery = this.status(deliveryId)[0];
      if (!delivery || delivery.status !== 'failed') throw new Error('Only failed trigger deliveries can be replayed');
      this.database.prepare("UPDATE trigger_deliveries SET status = 'pending', attempts = 0, nextAttemptAt = ? WHERE deliveryId = ?").run(Date.now(), deliveryId);
      return this.status(deliveryId)[0];
    });
    this.wake();
    return receipt;
  }

  start(): void {
    this.assertWritable();
    this.started = true;
    this.wake();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      if (this.timer) clearTimeout(this.timer);
      try {
        await this.running;
        if (this.started && !this.faulted) await this.drain();
      } finally {
        try { this.database.prepare('DELETE FROM trigger_queue_owner WHERE nonce = ?').run(this.nonce); }
        finally { this.database.close(); }
      }
      if (this.faulted) throw new Error('Trigger queue persistence failed; restart to recover pending deliveries');
    })();
  }

  private assertWritable(): void {
    if (this.closing || this.faulted) throw new Error('Trigger queue is unavailable');
  }

  private wake(delay = 0): void {
    if (!this.started || this.closing || this.faulted || this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.drain().catch(() => {
        this.faulted = true;
        try { this.onError(); } catch {}
      }).finally(() => {
        this.running = undefined;
        if (this.closing || this.faulted) return;
        try {
          const next = this.database.prepare("SELECT MIN(nextAttemptAt) AS due FROM trigger_deliveries WHERE status = 'pending'").get()?.due;
          if (typeof next === 'number') this.wake(Math.max(1, Math.min(60_000, next - Date.now())));
        } catch { this.faulted = true; try { this.onError(); } catch {} }
      });
    }, delay);
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    for (;;) {
      const delivery = transaction(this.database, () => {
        const row = this.database.prepare("SELECT deliveryId, providerId, body, attempts FROM trigger_deliveries WHERE status = 'pending' AND nextAttemptAt <= ? ORDER BY nextAttemptAt, deliveryId LIMIT 1").get(Date.now());
        if (!row) return undefined;
        this.database.prepare("UPDATE trigger_deliveries SET status = 'processing', attempts = attempts + 1 WHERE deliveryId = ?").run(row.deliveryId);
        return row as unknown as { deliveryId: string; providerId: string; body: string; attempts: number };
      });
      if (!delivery) return;
      let failed = false;
      try { await deliveryContext.run(delivery.deliveryId, () => this.dispatch(delivery)); }
      catch { failed = true; try { this.onError(); } catch {} }
      const attempts = delivery.attempts + 1;
      const status = failed ? attempts >= this.maxAttempts ? 'failed' : 'pending' : 'delivered';
      const next = Date.now() + Math.min(60_000, this.retryDelayMs * 2 ** (attempts - 1));
      this.database.prepare('UPDATE trigger_deliveries SET status = ?, nextAttemptAt = ?, deliveredAt = ? WHERE deliveryId = ?').run(status, next, failed ? null : Date.now(), delivery.deliveryId);
    }
  }
}
