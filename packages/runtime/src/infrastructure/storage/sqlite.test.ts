import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openSqlite, transaction, type SqliteDatabase } from './sqlite.js';

const directories: string[] = [];
const databases: SqliteDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('shared SQLite lifecycle', () => {
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
});
