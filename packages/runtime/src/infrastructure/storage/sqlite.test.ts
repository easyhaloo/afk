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

  it('lets a migration rebuild a referenced parent with foreign keys disabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-storage-fkoff-'));
    directories.push(root);
    const file = join(root, 'fk.sqlite');
    const v1Schema = `
      CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
      CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id), label TEXT NOT NULL) STRICT;
    `;
    const first = openSqlite({ file, schema: v1Schema, version: 1 });
    first.prepare('INSERT INTO parent (id, name) VALUES (1, ?)').run('kept');
    first.prepare('INSERT INTO child (id, parent_id, label) VALUES (10, 1, ?)').run('child-row');
    first.close();

    const reopened = openSqlite({
      file,
      version: 2,
      schema: v1Schema.replace('name TEXT NOT NULL', 'name TEXT NOT NULL, extra TEXT'),
      migrations: [{
        from: 1,
        to: 2,
        foreignKeys: 'off',
        migrate: database => {
          database.exec(`
            CREATE TABLE parent_v2 (id INTEGER PRIMARY KEY, name TEXT NOT NULL, extra TEXT) STRICT;
            INSERT INTO parent_v2 (id, name) SELECT id, name FROM parent;
            DROP TABLE parent;
            ALTER TABLE parent_v2 RENAME TO parent;
          `);
        },
      }],
    });
    databases.push(reopened);

    expect(reopened.prepare('SELECT name, extra FROM parent').all()).toEqual([{ name: 'kept', extra: null }]);
    expect(reopened.prepare('SELECT label FROM child').all()).toEqual([{ label: 'child-row' }]);
    // Enforcement is back on after the migration: a dangling reference fails.
    expect(() => reopened.prepare('INSERT INTO child (id, parent_id, label) VALUES (11, 99, ?)').run('dangling')).toThrow();
    expect(reopened.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
  });
});
