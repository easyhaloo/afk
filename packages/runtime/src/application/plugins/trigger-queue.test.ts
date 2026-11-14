import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openSqlite } from '../../infrastructure/storage/sqlite.js';
import { currentTriggerDeliveryId, DurableTriggerQueue, TriggerDeliveryConflict, TriggerQueueFull, type TriggerQueueOptions } from './trigger-queue.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
  vi.useRealTimers();
});

function queueFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'afk-trigger-queue-'));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'private', 'triggers.sqlite');
}

function queue(file: string, dispatch: ConstructorParameters<typeof DurableTriggerQueue>[1] = vi.fn(async () => {}), options: TriggerQueueOptions = { maxAttempts: 3, retryDelayMs: 10 }) {
  const onError = vi.fn();
  const instance = new DurableTriggerQueue(file, dispatch, options, onError);
  cleanup.push(() => instance.close().catch(() => {}));
  return { instance, dispatch, onError };
}

function database(file: string) {
  const connection = openSqlite({ file, schema: '', durability: 'FULL', version: 2 });
  cleanup.push(() => connection.close());
  return connection;
}

describe('durable trigger queue', () => {
  it('bounds close without releasing an unconfirmed active consumer', async () => {
    vi.useFakeTimers();
    const file = queueFile();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const first = queue(file, async () => pending);
    first.instance.enqueue('trigger.schedule', '{}', 'active');
    first.instance.enqueue('trigger.schedule', '{}', 'queued');
    first.instance.start();
    await vi.advanceTimersByTimeAsync(1);
    const closed = first.instance.close({ drain: false, timeoutMs: 10 });
    let failure: unknown;
    void closed.catch(error => { failure = error; });
    await vi.advanceTimersByTimeAsync(10);
    try {
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('ownership retained');
      expect(() => new DurableTriggerQueue(file, async () => {})).toThrow('already owned');
      expect(first.instance.status().map(row => row.status).sort()).toEqual(['pending', 'processing']);
      expect(() => first.instance.enqueue('trigger.schedule', '{}')).toThrow('unavailable');
    } finally { finish(); await first.instance.close({ drain: false }); }
    const next = queue(file);
    expect(next.instance.status().map(row => row.status).sort()).toEqual(['delivered', 'pending']);
  });

  it('can stop dispatching on close while retaining pending work for a new owner', async () => {
    vi.useFakeTimers();
    const file = queueFile();
    let finish!: () => void;
    const active = new Promise<void>(resolve => { finish = resolve; });
    const first = queue(file, vi.fn(async () => active));
    first.instance.enqueue('learning.distill', '{}', 'first');
    first.instance.enqueue('learning.distill', '{}', 'second');
    first.instance.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(first.dispatch).toHaveBeenCalledTimes(1);
    const closed = first.instance.close({ drain: false });
    finish();
    await closed;
    expect(first.dispatch).toHaveBeenCalledTimes(1);
    const restarted = queue(file);
    expect(restarted.instance.status().map(entry => entry.status).sort()).toEqual(['delivered', 'pending']);
    restarted.instance.start();
    await vi.advanceTimersByTimeAsync(1);
    await restarted.instance.close();
    expect(restarted.dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch a scheduled delivery when explicitly paused before it starts', async () => {
    const file = queueFile();
    const first = queue(file);
    first.instance.enqueue('learning.distill', '{}', 'first');
    first.instance.start();
    await first.instance.close({ drain: false });
    expect(first.dispatch).not.toHaveBeenCalled();
    expect(queue(file).instance.status()[0]?.status).toBe('pending');
  });
  it('paginates retained deliveries with validated bounds while preserving status by ID', () => {
    const file = queueFile();
    const { instance } = queue(file);
    const oldest = instance.enqueue('trigger.git-push', '{"ref":"old"}');
    const connection = database(file);
    connection.prepare("UPDATE trigger_deliveries SET status = 'failed', receivedAt = 0 WHERE deliveryId = ?").run(oldest.deliveryId);
    for (let index = 0; index < 100; index++) instance.enqueue('trigger.git-push', JSON.stringify({ ref: `new-${index}` }));
    expect(instance.status()).toHaveLength(100);
    expect(instance.status().some(delivery => delivery.deliveryId === oldest.deliveryId)).toBe(false);
    expect(instance.status(undefined, { offset: 100, limit: 100 })).toEqual(instance.status(oldest.deliveryId));
    expect(instance.status(oldest.deliveryId)[0].status).toBe('failed');
    expect(instance.status(undefined, { offset: 101, limit: 1 })).toEqual([]);
    for (const options of [{ offset: -1 }, { offset: 0.5 }, { offset: Number.MAX_SAFE_INTEGER + 1 }, { limit: 0 }, { limit: 101 }, { limit: 1.5 }, { limit: Infinity }]) {
      expect(() => instance.status(undefined, options)).toThrow(RangeError);
    }
  });

  it('persists receipts before dispatch and keeps its directory and SQLite files private', async () => {
    const file = queueFile();
    const { instance, dispatch } = queue(file);
    const receipt = instance.enqueue('trigger.git-push', '{"ref":"main"}', 'delivery-1');
    expect(receipt).toMatchObject({ status: 'pending', attempts: 0, duplicate: false });
    expect(dispatch).not.toHaveBeenCalled();
    expect(database(file).prepare('SELECT body FROM trigger_deliveries WHERE deliveryId = ?').get(receipt.deliveryId)?.body).toBe('{"ref":"main"}');
    expect(statSync(join(file, '..')).mode & 0o777).toBe(0o700);
    for (const filename of readdirSync(join(file, '..'))) expect(statSync(join(file, '..', filename)).mode & 0o777).toBe(0o600);
    instance.start();
    await vi.waitFor(() => expect(instance.status(receipt.deliveryId)[0].status).toBe('delivered'));
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: receipt.deliveryId }));
  });

  it('deduplicates stable source ids and identical bodies across restarts, with conflict detection and provider scoping', async () => {
    const file = queueFile();
    const first = queue(file);
    const receipt = first.instance.enqueue('trigger.git-push', '{"ref":"main"}', 'same');
    expect(first.instance.enqueue('trigger.git-push', '{"ref":"main"}', 'same')).toMatchObject({ deliveryId: receipt.deliveryId, duplicate: true });
    expect(() => first.instance.enqueue('trigger.git-push', '{"ref":"other"}', 'same')).toThrow(TriggerDeliveryConflict);
    const fallback = first.instance.enqueue('trigger.git-push', '{"ref":"main"}');
    expect(first.instance.enqueue('trigger.git-push', '{"ref":"main"}')).toMatchObject({ deliveryId: fallback.deliveryId, duplicate: true });
    expect(first.instance.enqueue('trigger.issue-event', '{"action":"opened"}', 'same').deliveryId).not.toBe(receipt.deliveryId);
    first.instance.start();
    await first.instance.close();
    expect(first.dispatch).toHaveBeenCalledTimes(3);
    const restarted = queue(file);
    restarted.instance.start();
    expect(restarted.instance.enqueue('trigger.git-push', '{"ref":"main"}', 'same')).toMatchObject({ status: 'delivered', duplicate: true });
    await restarted.instance.close();
    expect(restarted.dispatch).not.toHaveBeenCalled();
  });

  it('recovers accepted pending deliveries on restart', async () => {
    const file = queueFile();
    const first = queue(file);
    const receipt = first.instance.enqueue('trigger.git-push', '{"ref":"main"}');
    await first.instance.close();
    expect(first.dispatch).not.toHaveBeenCalled();
    const restarted = queue(file);
    restarted.instance.start();
    await vi.waitFor(() => expect(restarted.instance.status(receipt.deliveryId)[0]).toMatchObject({ status: 'delivered', attempts: 1 }));
    expect(restarted.dispatch).toHaveBeenCalledOnce();
  });

  it('rejects concurrent owners and recovers an interrupted attempt after its owner dies', async () => {
    const file = queueFile();
    const first = queue(file);
    const receipt = first.instance.enqueue('trigger.git-push', '{"ref":"main"}');
    expect(() => new DurableTriggerQueue(file, vi.fn())).toThrow('already owned');
    await first.instance.close();
    const connection = database(file);
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    connection.prepare('INSERT INTO trigger_queue_owner VALUES (1, ?, ?, ?)').run(deadPid, hostname(), 'dead-owner');
    connection.prepare("UPDATE trigger_deliveries SET status = 'processing', attempts = 1").run();
    const restarted = queue(file);
    restarted.instance.start();
    await vi.waitFor(() => expect(restarted.instance.status(receipt.deliveryId)[0]).toMatchObject({ status: 'delivered', attempts: 2 }));
  });

  it('fails closed for an unverifiable remote owner and exhausts interrupted final attempts', async () => {
    const file = queueFile();
    const first = queue(file);
    const receipt = first.instance.enqueue('trigger.git-push', '{}');
    await first.instance.close();
    const connection = database(file);
    connection.prepare('INSERT INTO trigger_queue_owner VALUES (1, ?, ?, ?)').run(process.pid, 'another-host', 'unknown');
    expect(() => new DurableTriggerQueue(file, vi.fn())).toThrow('unverifiable');
    connection.exec("DELETE FROM trigger_queue_owner; UPDATE trigger_deliveries SET status = 'processing', attempts = 3");
    const restarted = queue(file);
    restarted.instance.start();
    expect(restarted.instance.status(receipt.deliveryId)[0]).toMatchObject({ status: 'failed', attempts: 3 });
    await restarted.instance.close();
    expect(restarted.dispatch).not.toHaveBeenCalled();
  });

  it('bounds exponential retries and permits explicit replay under the original delivery id', async () => {
    vi.useFakeTimers();
    const file = queueFile();
    let fail = true;
    const observedIds: Array<string | undefined> = [];
    const dispatch = vi.fn(async () => {
      observedIds.push(currentTriggerDeliveryId());
      await Promise.resolve();
      expect(currentTriggerDeliveryId()).toBe(observedIds.at(-1));
      if (fail) throw new Error('secret-in-error');
    });
    const { instance, onError } = queue(file, dispatch);
    const receipt = instance.enqueue('trigger.git-push', '{}');
    instance.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.status(receipt.deliveryId)[0]).toMatchObject({ status: 'pending', attempts: 1 });
    await vi.advanceTimersByTimeAsync(10);
    expect(instance.status(receipt.deliveryId)[0]).toMatchObject({ status: 'pending', attempts: 2 });
    await vi.advanceTimersByTimeAsync(20);
    expect(instance.status(receipt.deliveryId)[0]).toMatchObject({ status: 'failed', attempts: 3 });
    await vi.advanceTimersByTimeAsync(100_000);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(onError).toHaveBeenCalledTimes(3);
    for (const filename of readdirSync(join(file, '..'))) expect(readFileSync(join(file, '..', filename)).includes(Buffer.from('secret-in-error'))).toBe(false);
    fail = false;
    expect(instance.replay(receipt.deliveryId)).toMatchObject({ deliveryId: receipt.deliveryId, status: 'pending', attempts: 0 });
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.status(receipt.deliveryId)[0]).toMatchObject({ status: 'delivered', attempts: 1 });
    expect(observedIds).toEqual(Array(4).fill(receipt.deliveryId));
    expect(currentTriggerDeliveryId()).toBeUndefined();
    expect(() => instance.replay(receipt.deliveryId)).toThrow('Only failed');
    expect(() => instance.replay('missing')).toThrow('Only failed');
  });

  it.each(['pending', 'processing', 'failed', 'delivered'])('counts %s records toward capacity without automatic eviction', state => {
    const file = queueFile();
    const { instance } = queue(file, undefined, { maxRecords: 1 });
    const receipt = instance.enqueue('trigger.git-push', '{}', 'first');
    database(file).prepare('UPDATE trigger_deliveries SET status = ?, deliveredAt = 0 WHERE deliveryId = ?').run(state, receipt.deliveryId);
    expect(() => instance.enqueue('trigger.git-push', '{}', 'second')).toThrow(TriggerQueueFull);
    expect(instance.storageUsage()).toMatchObject({ records: 1, bytes: 2, maxRecords: 1 });
    expect(instance.enqueue('trigger.git-push', '{}', 'first')).toMatchObject({ deliveryId: receipt.deliveryId, duplicate: true, status: state });
    expect(() => instance.enqueue('trigger.git-push', '{"changed":true}', 'first')).toThrow(TriggerDeliveryConflict);
    if (state === 'failed') expect(instance.replay(receipt.deliveryId)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('bounds aggregate UTF-8 payload bytes and preserves retained usage across restarts and reduced limits', async () => {
    const file = queueFile();
    const body = '{"message":"🔒"}';
    const bytes = Buffer.byteLength(body);
    const first = queue(file, undefined, { maxRecords: 3, maxBytes: bytes * 2 });
    const receipt = first.instance.enqueue('trigger.webhook', body, 'one');
    first.instance.enqueue('trigger.webhook', body, 'two');
    expect(first.instance.storageUsage()).toMatchObject({ records: 2, bytes: bytes * 2 });
    expect(() => first.instance.enqueue('trigger.webhook', body, 'three')).toThrow(TriggerQueueFull);
    await first.instance.close();
    const restarted = queue(file, undefined, { maxRecords: 1, maxBytes: bytes });
    expect(restarted.instance.storageUsage()).toEqual({ records: 2, bytes: bytes * 2, maxRecords: 1, maxBytes: bytes });
    expect(restarted.instance.enqueue('trigger.webhook', body, 'one')).toMatchObject({ deliveryId: receipt.deliveryId, duplicate: true });
    expect(() => restarted.instance.enqueue('trigger.webhook', '{}', 'three')).toThrow(TriggerQueueFull);
    expect(restarted.instance.pruneDelivered()).toBe(0);
    expect(restarted.instance.status()).toHaveLength(2);
  });

  it('explicitly prunes only expired delivered records, ending their dedupe window and freeing capacity', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const file = queueFile();
    const { instance } = queue(file, undefined, { maxRecords: 4, maxBytes: 8, deliveredRetentionMs: 100 });
    const receipt = instance.enqueue('trigger.git-push', '{}', 'delivered');
    vi.setSystemTime(10_000);
    instance.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(instance.status(receipt.deliveryId)[0].status).toBe('delivered');
    const connection = database(file);
    const completedAt = Number(connection.prepare('SELECT deliveredAt FROM trigger_deliveries WHERE deliveryId = ?').get(receipt.deliveryId)?.deliveredAt);
    for (const state of ['failed', 'pending', 'processing']) {
      const retained = instance.enqueue('trigger.git-push', '{}', state);
      connection.prepare('UPDATE trigger_deliveries SET status = ?, deliveredAt = 0 WHERE deliveryId = ?').run(state, retained.deliveryId);
    }
    expect(() => instance.enqueue('trigger.git-push', '{}', 'new')).toThrow(TriggerQueueFull);
    expect(instance.pruneDelivered()).toBe(0);
    vi.setSystemTime(completedAt + 99);
    expect(instance.pruneDelivered()).toBe(0);
    vi.setSystemTime(completedAt + 100);
    expect(instance.pruneDelivered()).toBe(1);
    expect(instance.storageUsage()).toMatchObject({ records: 3, bytes: 6 });
    expect(instance.status().map(delivery => delivery.status).sort()).toEqual(['failed', 'pending', 'processing']);
    expect(instance.enqueue('trigger.git-push', '{}', 'delivered')).toMatchObject({ deliveryId: receipt.deliveryId, duplicate: false, status: 'pending' });
  });

  it('isolates delivery context between concurrent queues and restores the caller context', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const seen: Array<string | undefined> = [];
    const dispatch = vi.fn(async (delivery: { deliveryId: string }) => {
      expect(currentTriggerDeliveryId()).toBe(delivery.deliveryId);
      await gate;
      await new Promise<void>(resolve => setImmediate(resolve));
      seen.push(currentTriggerDeliveryId());
      expect(currentTriggerDeliveryId()).toBe(delivery.deliveryId);
    });
    const first = queue(queueFile(), dispatch);
    const second = queue(queueFile(), dispatch);
    const firstReceipt = first.instance.enqueue('trigger.git-push', '{}', 'one');
    const secondReceipt = second.instance.enqueue('trigger.git-push', '{}', 'two');
    first.instance.start();
    second.instance.start();
    try {
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
      expect(currentTriggerDeliveryId()).toBeUndefined();
    } finally { release(); }
    await vi.waitFor(() => expect(seen).toHaveLength(2));
    expect(seen.sort()).toEqual([firstReceipt.deliveryId, secondReceipt.deliveryId].sort());
    expect(currentTriggerDeliveryId()).toBeUndefined();
  });

  it('migrates previous receipts without losing payload bytes or shortening their delivered retention window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const file = queueFile();
    const legacy = openSqlite({ file, schema: `
      CREATE TABLE trigger_deliveries (deliveryId TEXT PRIMARY KEY, providerId TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL, receivedAt INTEGER NOT NULL, nextAttemptAt INTEGER NOT NULL);
      CREATE TABLE trigger_queue_owner (singleton INTEGER PRIMARY KEY, pid INTEGER NOT NULL, host TEXT NOT NULL, nonce TEXT NOT NULL);
    ` });
    const body = '{"message":"🔒"}';
    try {
      legacy.prepare("INSERT INTO trigger_deliveries VALUES ('legacy', 'trigger.webhook', ?, 'digest', 'delivered', 1, 0, 0)").run(body);
      legacy.prepare('INSERT INTO trigger_queue_owner VALUES (1, ?, ?, ?)').run(process.pid, hostname(), 'live');
      expect(() => new DurableTriggerQueue(file, vi.fn())).toThrow('already owned');
      expect(legacy.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
      legacy.exec('DELETE FROM trigger_queue_owner');
    } finally { legacy.close(); }
    const { instance } = queue(file, undefined, { maxRecords: 1, deliveredRetentionMs: 100 });
    expect(instance.storageUsage()).toMatchObject({ records: 1, bytes: Buffer.byteLength(body) });
    expect(instance.pruneDelivered()).toBe(0);
    expect(() => instance.enqueue('trigger.webhook', '{}')).toThrow(TriggerQueueFull);
    vi.setSystemTime(10_100);
    expect(instance.pruneDelivered()).toBe(1);
    expect(instance.storageUsage()).toMatchObject({ records: 0, bytes: 0 });
  });

  it('does not acknowledge or dispatch a receipt when persistence fails', async () => {
    const file = queueFile();
    const { instance, dispatch } = queue(file);
    database(file).exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON trigger_deliveries BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    instance.start();
    expect(() => instance.enqueue('trigger.git-push', '{}')).toThrow('disk full');
    await instance.close();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('recovers an uncertain completion after a failed state write without claiming exactly-once delivery', async () => {
    const file = queueFile();
    const first = queue(file);
    const receipt = first.instance.enqueue('trigger.git-push', '{}');
    const connection = database(file);
    connection.exec("CREATE TRIGGER fail_completion BEFORE UPDATE ON trigger_deliveries WHEN NEW.status = 'delivered' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    first.instance.start();
    await vi.waitFor(() => expect(first.onError).toHaveBeenCalledOnce());
    await expect(first.instance.close()).rejects.toThrow('persistence failed');
    expect(first.dispatch).toHaveBeenCalledOnce();
    connection.exec('DROP TRIGGER fail_completion');
    const restarted = queue(file);
    restarted.instance.start();
    await vi.waitFor(() => expect(restarted.instance.status(receipt.deliveryId)[0]).toMatchObject({ status: 'delivered', attempts: 2 }));
    expect(restarted.dispatch).toHaveBeenCalledOnce();
  });

  it('drains accepted work during close and leaves delayed retries pending for restart', async () => {
    const file = queueFile();
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const dispatch = vi.fn(async () => { entered(); await gate; throw new Error('retry later'); });
    const { instance } = queue(file, dispatch, { maxAttempts: 3, retryDelayMs: 60_000 });
    const receipt = instance.enqueue('trigger.git-push', '{}');
    instance.start();
    let closed = false;
    const stopping = instance.close().then(() => { closed = true; });
    try {
      await started;
      expect(closed).toBe(false);
      expect(() => instance.enqueue('trigger.git-push', '{}')).toThrow('unavailable');
    } finally { release(); await stopping; }
    await instance.close();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(database(file).prepare('SELECT status, attempts FROM trigger_deliveries WHERE deliveryId = ?').get(receipt.deliveryId)).toEqual({ status: 'pending', attempts: 1 });
  });

  it('rejects unsafe paths, payload and retry limits', () => {
    expect(() => new DurableTriggerQueue(':memory:', vi.fn())).toThrow('durable');
    expect(() => new DurableTriggerQueue(queueFile(), vi.fn(), { maxAttempts: 0 })).toThrow('retry limits');
    expect(() => new DurableTriggerQueue(queueFile(), vi.fn(), { retryDelayMs: 0 })).toThrow('retry limits');
    for (const limits of [{ maxRecords: 0 }, { maxRecords: NaN }, { maxBytes: 0 }, { maxBytes: Infinity }, { deliveredRetentionMs: 0 }]) {
      expect(() => new DurableTriggerQueue(queueFile(), vi.fn(), limits)).toThrow('storage limits');
    }
    const file = queueFile();
    const { instance } = queue(file);
    expect(() => instance.enqueue('trigger.git-push', '{}', 'bad id')).toThrow('Invalid trigger');
    expect(() => instance.enqueue('trigger.git-push', 'x'.repeat(1024 * 1024 + 1))).toThrow('Invalid trigger');
    const link = join(file, '..', 'link.sqlite');
    symlinkSync(file, link);
    expect(() => new DurableTriggerQueue(link, vi.fn())).toThrow();
    const unsafe = join(file, '..', 'unsafe.sqlite');
    writeFileSync(unsafe + '-wal', 'data');
    symlinkSync(file, unsafe + '-shm');
    expect(() => new DurableTriggerQueue(unsafe, vi.fn())).toThrow();
  });
});
