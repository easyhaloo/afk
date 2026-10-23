import { createRequire } from 'node:module';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SqliteStatement {
  run(...parameters: unknown[]): unknown;
  get(...parameters: unknown[]): { [column: string]: unknown } | undefined;
  all(...parameters: unknown[]): Array<{ [column: string]: unknown }>;
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

export function transaction<Result>(database: SqliteDatabase, operation: () => Result): Result {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function openSqlite(options: {
  file: string;
  schema: string;
  durability?: 'NORMAL' | 'FULL';
  initialize?: (database: SqliteDatabase) => void;
}): SqliteDatabase {
  const requireNode = createRequire(import.meta.url);
  let Sqlite: new (path: string) => SqliteDatabase;
  try {
    Sqlite = (requireNode(`node:${'sqlite'}`) as { DatabaseSync: typeof Sqlite }).DatabaseSync;
  } catch {
    throw new Error('AFK SQLite storage requires a Node runtime with node:sqlite support (tested on Node 22.16+)');
  }
  if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
  const database = new Sqlite(options.file);
  try {
    if (options.file !== ':memory:' && process.platform !== 'win32') chmodSync(options.file, 0o600);
    database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;`);
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 1) throw new Error(`Unsupported AFK storage schema version: ${version}`);
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${options.durability ?? 'NORMAL'};`);
    transaction(database, () => {
      const lockedVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
      if (lockedVersion > 1) throw new Error(`Unsupported AFK storage schema version: ${lockedVersion}`);
      if (lockedVersion === 0) {
        database.exec(options.schema);
        database.exec('PRAGMA user_version = 1');
      }
      options.initialize?.(database);
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
