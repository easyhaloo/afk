import { createRequire } from 'node:module';
import { openSqlite, requireNodeSqlite, transaction, type SqliteDatabase, type SqliteStatement } from './sqlite.js';

const { DatabaseSync } = requireNodeSqlite<{ DatabaseSync: new (file: string) => SqliteDatabase }>(createRequire(import.meta.url));
const file = process.argv[2]!;
const mode = process.argv[3]!;
let database: SqliteDatabase | undefined;
let statement: SqliteStatement | undefined;
let closed = false;

process.on('message', (message: { action: string; delay?: number; id?: string }) => {
  if (message.action === 'hold') {
    database = new DatabaseSync(file);
    if (mode !== 'statement') database.exec(mode === 'reader' ? 'BEGIN' : 'BEGIN IMMEDIATE');
    statement = database.prepare('PRAGMA user_version');
    statement.get();
    process.send?.({ type: 'held' });
  } else if (message.action === 'release') {
    setTimeout(() => {
      database!.exec('ROLLBACK');
      database!.close();
      closed = true;
      process.send?.({ type: 'released' });
    }, message.delay ?? 0);
  } else if (message.action === 'open') {
    const execute = DatabaseSync.prototype.exec;
    const close = DatabaseSync.prototype.close;
    const wait = Atomics.wait;
    const waits: number[] = [];
    const busy: number[] = [];
    let attempted: SqliteDatabase | undefined;
    let closeCalls = 0;
    let initializeCalls = 0;
    let walAttempts = 0;
    DatabaseSync.prototype.exec = function (sql: string) {
      attempted = this;
      if (sql === 'PRAGMA journal_mode = WAL') {
        if (++walAttempts === 1) process.send?.({ type: 'wal-attempt' });
        try { return execute.call(this, sql); }
        catch (error) { busy.push((error as { errcode: number }).errcode); throw error; }
      }
      return execute.call(this, sql);
    };
    DatabaseSync.prototype.close = function () {
      closeCalls++;
      return close.call(this);
    };
    Atomics.wait = ((array: Int32Array, index: number, value: number, timeout: number) => {
      waits.push(timeout);
      return wait(array, index, value, timeout);
    }) as typeof Atomics.wait;
    const started = performance.now();
    try {
      database = openSqlite({ file, schema: 'CREATE TABLE sample(id TEXT PRIMARY KEY) STRICT;', durability: 'FULL',
        initialize: () => { initializeCalls++; } });
      process.send?.({ type: 'opened', ok: true, waits, busy, walAttempts, initializeCalls,
        elapsed: performance.now() - started, journal: database.prepare('PRAGMA journal_mode').get()?.journal_mode,
        durability: database.prepare('PRAGMA synchronous').get()?.synchronous,
        timeout: database.prepare('PRAGMA busy_timeout').get()?.timeout });
    } catch (error) {
      try { attempted?.prepare('SELECT 1'); }
      catch { closed = true; }
      const failure = error as Error & { code?: string; errcode?: number };
      process.send?.({ type: 'opened', ok: false, error: failure.message, code: failure.code, errcode: failure.errcode,
        waits, busy, walAttempts, initializeCalls, closeCalls, closed, elapsed: performance.now() - started });
    } finally {
      DatabaseSync.prototype.exec = execute;
      DatabaseSync.prototype.close = close;
      Atomics.wait = wait;
    }
  } else if (message.action === 'write') {
    transaction(database!, () => database!.prepare('INSERT INTO sample VALUES (?)').run(message.id));
    process.send?.({ type: 'written' });
  } else if (message.action === 'inspect') {
    process.send?.({ type: 'inspected', rows: database!.prepare('SELECT id FROM sample ORDER BY id').all(),
      version: database!.prepare('PRAGMA user_version').get()?.user_version });
  } else if (message.action === 'version') {
    process.send?.({ type: 'version', version: statement!.get()?.user_version });
  } else if (message.action === 'close') {
    if (database && !closed) database.close();
    closed = true;
    process.disconnect();
  }
});
process.send?.({ type: 'ready' });
