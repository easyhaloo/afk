import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { openSqlite, requireNodeSqlite, transaction, type SqliteDatabase } from './sqlite.js';

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
const children: ChildProcess[] = [];
const childErrors = new WeakMap<ChildProcess, string>();
let fixtureRoot: string;
let fixture: string;

type ProcessMessage = { type: string; [key: string]: unknown };

function response(child: ChildProcess, type: string): Promise<ProcessMessage> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('error', error);
      child.off('exit', exit);
    };
    const message = (value: ProcessMessage) => {
      if (value.type !== type) return;
      clean();
      resolve(value);
    };
    const error = (failure: Error) => { clean(); reject(failure); };
    const exit = (code: number | null, signal: string | null) => error(new Error(`SQLite child exited (${code ?? signal}): ${childErrors.get(child) ?? ''}`));
    const timer = setTimeout(() => error(new Error(`SQLite child response timeout: ${type}`)), 10000);
    child.on('message', message);
    child.once('error', error);
    child.once('exit', exit);
  });
}

async function startProcess(file: string, mode = 'opener') {
  const child = fork(fixture, [file, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  children.push(child);
  child.stderr?.on('data', chunk => childErrors.set(child, `${childErrors.get(child) ?? ''}${chunk}`.slice(-4000)));
  await response(child, 'ready');
  return child;
}

function send(child: ChildProcess, action: string, type: string, input: { delay?: number; id?: string } = {}) {
  const result = response(child, type);
  child.send({ action, ...input });
  return result;
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL');
  await exit;
}

beforeAll(async () => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'afk-sqlite-process-'));
  fixture = join(fixtureRoot, 'sqlite-process.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('./sqlite-process.fixture.spec.ts', import.meta.url))],
    outfile: fixture, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
});
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(stopProcess));
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('shared SQLite lifecycle', () => {
  // This runs first on purpose: the runtime prints its experimental warning
  // only when node:sqlite is loaded for the first time, and the fork running
  // this file has not loaded it yet.
  it('does not leak the node:sqlite experimental warning into stderr', async () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-storage-'));
    directories.push(root);
    const chunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const originalEmitWarning = process.emitWarning;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      chunks.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    }) as typeof process.stderr.write;
    try {
      const database = openSqlite({ file: join(root, 'quiet.sqlite'), schema: 'CREATE TABLE sample(id TEXT PRIMARY KEY) STRICT;' });
      databases.push(database);
      // The runtime prints its warnings on the next tick.
      await new Promise<void>(resolve => setImmediate(resolve));
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(chunks.join('')).not.toMatch(/SQLite is an experimental feature/);
    // The warning channel is handed back untouched, so later warnings still
    // reach the runtime.
    expect(process.emitWarning).toBe(originalEmitWarning);
  });

  it('initializes once, reopens data, rolls back and protects the database file', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-storage-'));
    directories.push(root);
    const file = join(root, 'data', 'config.sqlite');
    const options = { file, schema: 'CREATE TABLE sample (id TEXT PRIMARY KEY) STRICT;', durability: 'FULL' as const };
    const first = openSqlite(options);
    first.prepare('INSERT INTO sample VALUES (?)').run('original');
    expect(() => transaction(first, () => {
      first.prepare('INSERT INTO sample VALUES (?)').run('rolled-back');
      throw new Error('interrupt');
    })).toThrow('interrupt');
    first.close();
    const reopened = openSqlite(options);
    databases.push(reopened);
    expect(reopened.prepare('SELECT id FROM sample').all()).toEqual([{ id: 'original' }]);
    expect(reopened.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(reopened.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    reopened.exec('PRAGMA user_version = 2');
    expect(() => openSqlite(options)).toThrow(/version/i);
  });

  it('rolls back a failed initialization instead of accepting a partial schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-storage-'));
    directories.push(root);
    const file = join(root, 'failed.sqlite');
    expect(() => openSqlite({ file, schema: 'CREATE TABLE sample(id); INVALID SQL;' })).toThrow();
    const repaired = openSqlite({ file, schema: 'CREATE TABLE sample(id TEXT PRIMARY KEY) STRICT;' });
    databases.push(repaired);
    expect(repaired.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
  });

  it('retries a real WAL SQLITE_BUSY on the same connection after the competing lock is released', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-busy-'));
    directories.push(root);
    const file = join(root, 'data.sqlite');
    const { DatabaseSync } = requireNodeSqlite<{ DatabaseSync: new (file: string) => SqliteDatabase }>(createRequire(import.meta.url));
    const initial = new DatabaseSync(file);
    initial.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('keep')");
    initial.close();
    const execute = DatabaseSync.prototype.exec;
    let attempts = 0;
    let busy: unknown;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: SqliteDatabase, sql: string) {
      if (sql.includes('PRAGMA journal_mode = WAL') && ++attempts === 1) {
        const holder = new DatabaseSync(file);
        execute.call(holder, 'BEGIN IMMEDIATE');
        execute.call(this, 'PRAGMA busy_timeout = 0');
        try { return execute.call(this, sql); }
        catch (error) { busy = error; throw error; }
        finally { execute.call(holder, 'ROLLBACK'); holder.close(); }
      }
      return execute.call(this, sql);
    });
    const database = openSqlite({ file, schema: 'CREATE TABLE sample(id TEXT)' });
    databases.push(database);
    expect(busy).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 });
    expect(attempts).toBe(2);
    expect(database.prepare('SELECT value FROM sentinel').get()?.value).toBe('keep');
    expect(database.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('wal');
    expect(database.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(3000);
  });

  it('bounds persistent WAL busy retries and returns the original error without creating a schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-exhausted-'));
    directories.push(root);
    const file = join(root, 'data.sqlite');
    const { DatabaseSync } = requireNodeSqlite<{ DatabaseSync: new (file: string) => SqliteDatabase }>(createRequire(import.meta.url));
    const execute = DatabaseSync.prototype.exec;
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    let attempts = 0;
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(1).mockReturnValue(3001);
    vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    const spy = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: SqliteDatabase, sql: string) {
      if (sql.includes('PRAGMA journal_mode = WAL')) { attempts++; throw busy; }
      return execute.call(this, sql);
    });
    expect(() => openSqlite({ file, schema: 'CREATE TABLE sample(id TEXT)' })).toThrow(busy);
    expect(attempts).toBe(2);
    spy.mockRestore();
    const check = new DatabaseSync(file);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'sample'").get()).toBeUndefined();
    check.close();
  });

  it.each([261, 773])('retries transient WAL busy extension %s without replaying initialization', errcode => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-recovery-'));
    directories.push(root);
    const { DatabaseSync } = requireNodeSqlite<{ DatabaseSync: new (file: string) => SqliteDatabase }>(createRequire(import.meta.url));
    const execute = DatabaseSync.prototype.exec;
    const failure = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode });
    let attempts = 0;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: SqliteDatabase, sql: string) {
      if (sql.includes('PRAGMA journal_mode = WAL') && ++attempts === 1) throw failure;
      return execute.call(this, sql);
    });
    const initialize = vi.fn();
    const database = openSqlite({ file: join(root, 'data.sqlite'), schema: 'CREATE TABLE sample(id TEXT)', initialize });
    databases.push(database);
    expect(attempts).toBe(2);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(database.prepare('PRAGMA busy_timeout').get()?.timeout).toBe(3000);
  });

  it.each([6, 262, 11, 26, 517, undefined])('does not retry non-retryable WAL error %s', errcode => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-error-'));
    directories.push(root);
    const { DatabaseSync } = requireNodeSqlite<{ DatabaseSync: new (file: string) => SqliteDatabase }>(createRequire(import.meta.url));
    const execute = DatabaseSync.prototype.exec;
    const failure = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode });
    let attempts = 0;
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: SqliteDatabase, sql: string) {
      if (sql.includes('PRAGMA journal_mode = WAL')) { attempts++; throw failure; }
      return execute.call(this, sql);
    });
    expect(() => openSqlite({ file: join(root, 'data.sqlite'), schema: '' })).toThrow(failure);
    expect(attempts).toBe(1);
  });

  it('preserves a corrupt file and does not retry a migration callback even when it throws SQLITE_BUSY', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-migration-error-'));
    directories.push(root);
    const corrupt = join(root, 'corrupt.sqlite');
    writeFileSync(corrupt, 'not a SQLite database');
    const original = readFileSync(corrupt);
    expect(() => openSqlite({ file: corrupt, schema: '' })).toThrow();
    expect(readFileSync(corrupt)).toEqual(original);
    const file = join(root, 'data.sqlite');
    openSqlite({ file, schema: "CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES ('keep')" }).close();
    const failure = Object.assign(new Error('migration busy'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    const migrate = vi.fn((database: SqliteDatabase) => {
      database.exec('DELETE FROM sample; CREATE TABLE partial(id TEXT)');
      throw failure;
    });
    expect(() => openSqlite({ file, schema: '', version: 2, migrations: [{ from: 1, to: 2, migrate }] })).toThrow(failure);
    expect(migrate).toHaveBeenCalledTimes(1);
    const check = openSqlite({ file, schema: '' });
    databases.push(check);
    expect(check.prepare('SELECT value FROM sample').get()?.value).toBe('keep');
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'partial'").get()).toBeUndefined();
  });

  it.each(['reader', 'writer'])('backs off a real subprocess %s lock and initializes once after release', async mode => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-process-'));
    directories.push(root);
    const file = join(root, 'data.sqlite');
    const holder = await startProcess(file, mode);
    await send(holder, 'hold', 'held');
    const opener = await startProcess(file);
    const firstAttempt = response(opener, 'wal-attempt');
    const opened = send(opener, 'open', 'opened');
    await firstAttempt;
    const released = send(holder, 'release', 'released', { delay: 600 });
    const result = await opened;
    await released;
    expect(result).toMatchObject({ ok: true, initializeCalls: 1, journal: 'wal', durability: 2, timeout: 3000 });
    expect(result.busy).toContain(5);
    const waits = result.waits as number[];
    expect(Math.max(...waits)).toBeGreaterThan(25);
    expect(waits.every(pause => pause > 0 && pause <= 250)).toBe(true);
    await send(opener, 'write', 'written', { id: 'preserved' });
    expect(await send(opener, 'inspect', 'inspected')).toMatchObject({ rows: [{ id: 'preserved' }], version: 1 });
  });

  it('switches WAL while another process retains a completed user_version statement and its connection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-retained-statement-'));
    directories.push(root);
    const file = join(root, 'data.sqlite');
    const holder = await startProcess(file, 'statement');
    await send(holder, 'hold', 'held');
    const opener = await startProcess(file);
    expect(await send(opener, 'open', 'opened')).toMatchObject({ ok: true, journal: 'wal', initializeCalls: 1 });
    expect(await send(holder, 'version', 'version')).toMatchObject({ version: 1 });
  });

  it('caps a jittered pause at the remaining deadline and closes without initializing after exhaustion', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-deadline-'));
    directories.push(root);
    const { DatabaseSync } = requireNodeSqlite<{ DatabaseSync: new (file: string) => SqliteDatabase }>(createRequire(import.meta.url));
    const execute = DatabaseSync.prototype.exec;
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(2999).mockReturnValue(3001);
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const wait = vi.spyOn(Atomics, 'wait').mockReturnValue('timed-out');
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (this: SqliteDatabase, sql: string) {
      if (sql === 'PRAGMA journal_mode = WAL') throw busy;
      return execute.call(this, sql);
    });
    const initialize = vi.fn();
    expect(() => openSqlite({ file: join(root, 'data.sqlite'), schema: '', initialize })).toThrow(busy);
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]?.[3]).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(initialize).not.toHaveBeenCalled();
  });

  it('closes the connection and preserves a real busy error when a subprocess holds its lock past the deadline', async () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-process-exhausted-'));
    directories.push(root);
    const file = join(root, 'data.sqlite');
    const holder = await startProcess(file, 'reader');
    await send(holder, 'hold', 'held');
    const opener = await startProcess(file);
    const result = await send(opener, 'open', 'opened');
    expect(result).toMatchObject({ ok: false, code: 'ERR_SQLITE_ERROR', errcode: 5,
      initializeCalls: 0, closeCalls: 1, closed: true, error: expect.stringMatching(/locked/) });
    expect(Number(result.elapsed)).toBeGreaterThanOrEqual(2900);
    expect(Number(result.elapsed)).toBeLessThan(6000);
    await send(holder, 'release', 'released');
    const { DatabaseSync } = requireNodeSqlite<{ DatabaseSync: new (file: string) => SqliteDatabase }>(createRequire(import.meta.url));
    const check = new DatabaseSync(file);
    databases.push(check);
    expect(check.prepare('PRAGMA user_version').get()?.user_version).toBe(0);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name = 'sample'").get()).toBeUndefined();
    check.exec('BEGIN EXCLUSIVE; ROLLBACK');
  });

  it('cold-starts sixty independent pairs while both connections stay open behind the ready barrier', async () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-wal-process-cold-'));
    directories.push(root);
    for (let pair = 0; pair < 60; pair++) {
      const file = join(root, String(pair), 'data.sqlite');
      const processes = await Promise.all([startProcess(file), startProcess(file)]);
      const results = await Promise.all(processes.map(child => send(child, 'open', 'opened')));
      for (const result of results) expect(result, `cold pair ${pair}`).toMatchObject({ ok: true, initializeCalls: 1, journal: 'wal' });
      await Promise.all(processes.map((child, producer) => send(child, 'write', 'written', { id: `producer-${producer}` })));
      expect(await send(processes[0]!, 'inspect', 'inspected')).toMatchObject({
        rows: [{ id: 'producer-0' }, { id: 'producer-1' }], version: 1,
      });
      await Promise.all(processes.map(stopProcess));
    }
  });
});
