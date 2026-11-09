import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, requireNodeSqlite, transaction, type SqliteDatabase } from './sqlite.js';

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
});
