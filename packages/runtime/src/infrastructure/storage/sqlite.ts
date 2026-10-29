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

/**
 * Load `node:sqlite` without the runtime's experimental warning.
 *
 * `node:sqlite` is still experimental on the supported Node baseline, and
 * Node prints a warning the first time the module is loaded. That warning is
 * about this implementation detail, not about the caller's command, and it
 * would pollute the stderr that the CLI reserves for machine-readable
 * output. Only that single warning is dropped, and only while the module
 * loads — every other warning still reaches the runtime.
 */
function requireNodeSqlite<T>(requireNode: ReturnType<typeof createRequire>): T {
  const emitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, type?: string, ...rest: unknown[]) => {
    if (type === 'ExperimentalWarning' && typeof warning === 'string' && warning.includes('SQLite')) return;
    return (emitWarning as (...arguments_: unknown[]) => void).call(process, warning, type, ...rest);
  }) as unknown as typeof process.emitWarning;
  try {
    return requireNode(`node:${'sqlite'}`) as T;
  } finally {
    process.emitWarning = emitWarning;
  }
}

/**
 * One schema step between two stored versions.
 *
 * A migration runs inside the same transaction as the initialization, so a
 * database that fails to migrate keeps its previous schema instead of a
 * half-applied one.
 */
export interface SqliteMigration {
  /** The stored version this step upgrades from. */
  from: number;
  /** The stored version this step produces. */
  to: number;
  migrate: (database: SqliteDatabase) => void;
}

/**
 * Bring an older database up to the expected version.
 *
 * The steps must chain: each one starts where the previous one ended.
 */
function applyMigrations(
  database: SqliteDatabase,
  from: number,
  to: number,
  migrations: readonly SqliteMigration[],
): void {
  let version = from;
  while (version < to) {
    const migration = migrations.find(candidate => candidate.from === version);
    if (!migration) throw new Error(`No AFK storage schema migration from version ${version}`);
    migration.migrate(database);
    version = migration.to;
    database.exec(`PRAGMA user_version = ${version}`);
  }
}

export function openSqlite(options: {
  file: string;
  schema: string;
  durability?: 'NORMAL' | 'FULL';
  /** The schema version this database is expected to hold. Defaults to 1. */
  version?: number;
  /** The steps that bring an older database up to `version`. */
  migrations?: readonly SqliteMigration[];
  initialize?: (database: SqliteDatabase) => void;
}): SqliteDatabase {
  const requireNode = createRequire(import.meta.url);
  let Sqlite: new (path: string) => SqliteDatabase;
  try {
    Sqlite = requireNodeSqlite<{ DatabaseSync: typeof Sqlite }>(requireNode).DatabaseSync;
  } catch {
    throw new Error('AFK SQLite storage requires a Node runtime with node:sqlite support (tested on Node 22.16+)');
  }
  const expectedVersion = options.version ?? 1;
  if (options.file !== ':memory:') mkdirSync(dirname(options.file), { recursive: true, mode: 0o700 });
  const database = new Sqlite(options.file);
  try {
    if (options.file !== ':memory:' && process.platform !== 'win32') chmodSync(options.file, 0o600);
    database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;`);
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    if (version > expectedVersion) throw new Error(`Unsupported AFK storage schema version: ${version}`);
    database.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${options.durability ?? 'NORMAL'};`);
    transaction(database, () => {
      const lockedVersion = Number(database.prepare('PRAGMA user_version').get()?.user_version);
      if (lockedVersion > expectedVersion) throw new Error(`Unsupported AFK storage schema version: ${lockedVersion}`);
      if (lockedVersion === 0) {
        database.exec(options.schema);
        database.exec(`PRAGMA user_version = ${expectedVersion}`);
      } else {
        applyMigrations(database, lockedVersion, expectedVersion, options.migrations ?? []);
      }
      options.initialize?.(database);
    });
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
