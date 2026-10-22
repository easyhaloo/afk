import pino from 'pino';
import pretty from 'pino-pretty';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Console } from 'node:console';
import { Writable } from 'node:stream';
import { closeSync, openSync, writeSync } from 'fs';
import { ensureLogDir, pruneStaleLogs, resolveLogDir, resolveLogPath } from './log-paths.js';

export interface LogContext {
  runId: string;
  workItemId: string;
}

const logContext = new AsyncLocalStorage<Readonly<LogContext>>();

export function getLogContext(): Readonly<LogContext> | undefined {
  return logContext.getStore();
}

export function withLogContext<T>(context: LogContext, asyncFn: () => Promise<T>): Promise<T> {
  return logContext.run({ runId: context.runId, workItemId: context.workItemId }, asyncFn);
}

// ── Unified day-rotated log file ────────────────────────────────────────────

// The destination and its day rotation live in ./log-paths.ts — the single
// source of truth for every AFK log path. Re-exported here because
// `resolveLogPath()` is part of this module's published surface.
export { resolveLogPath };

/**
 * Day log as a real Writable stream with a SYNCHRONOUS `_write`.
 *
 * Writes stay synchronous: Writable.write() calls _write() inline when there
 * is no backpressure (our _write is sync and calls back immediately, so
 * there never is), and _write does fs.writeSync — a log line lands on disk
 * before the call returns, which is what keeps logs from vanishing on a fast
 * process.exit() (the pino-pretty async-SonicBoom race that previously threw
 * "sonic boom is not ready yet").
 *
 * It must be a genuine Writable, not a plain object with write(): Node's
 * Console only writes to real streams (verified against v24.18 — a plain
 * { write } object is silently ignored), and pino/multistream behave
 * uniformly. The fd is opened lazily on first write, so NODE_ENV=test
 * (silent level, no writes) never touches disk.
 */
export class DayRotator extends Writable {
  private fd: number | null = null;
  private current: string | null = null;

  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const file = resolveLogPath();
      if (file !== this.current || this.fd === null) this.openFor(file);
      writeSync(this.fd!, chunk);
      callback();
    } catch {
      // Swallow write failures (disk full, EMFILE...). Passing the error to
      // callback() would emit 'error' on the stream — with no listener that
      // crashes the daemon, and with one it destroys the stream so every
      // later log line is lost too. Logging I/O failing must never kill the
      // loop; the next write simply retries.
      callback();
    }
  }

  private openFor(file: string): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* ignore */
      }
    }
    try {
      ensureLogDir(resolveLogDir());
    } catch {
      /* ignore */
    }
    this.fd = openSync(file, 'a');
    this.current = file;
    pruneStaleLogs();
  }
}

export const dayLog = new DayRotator();

// ── pino instances ──────────────────────────────────────────────────────────

const isTest = process.env.NODE_ENV === 'test';
const level = isTest ? 'silent' : (process.env.LOG_LEVEL || 'info');
const consoleActive = !isTest && Boolean(process.stderr.isTTY);

// Explicit key paths only — @pinojs/redact (pino 10) treats '*token' as a
// literal key name, not a suffix wildcard (verified against 0.4.0: the
// pattern redacts nothing). List bare keys for any nesting level.
const pinoOpts: pino.LoggerOptions = {
  level,
  base: { name: 'afk' },
  mixin: () => ({ ...getLogContext() }),
  redact: {
    paths: [
      'token', 'password', 'secret', 'key',
      '*.token', '*.password', '*.secret', '*.key',
    ],
    censor: '[redacted]',
  },
  // `error` is the key most call sites use; without a serializer pino JSON.stringify's
  // it, and every Error degrades to its enumerable own properties (message and
  // stack are non-enumerable), hiding the real cause in the log.
  serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
};

// Console stream -> stderr so diagnostic logs never pollute stdout that users
// pipe (e.g. `afk issue list | jq`). User-facing command output stays on
// console.log / process.stdout.
//
// TTY: diagnostics go to both stderr (pretty, human) and the day log
// (JSONL, machine-readable). Daemon: stderr is not a TTY, so only the day
// log — and `fileLogger` IS `logger` (same destination, same instance).
let logger: pino.Logger;
let fileLogger: pino.Logger;
if (consoleActive) {
  const prettyStream = pretty({
    colorize: true,
    translateTime: 'SYS:standard',
    ignore: 'pid,hostname',
    destination: process.stderr,
  });
  logger = pino(
    pinoOpts,
    pino.multistream([
      { stream: prettyStream, level },
      { stream: dayLog, level },
    ]),
  );
  fileLogger = pino(pinoOpts, dayLog);
} else {
  logger = pino(pinoOpts, dayLog);
  fileLogger = logger;
}

export { logger, fileLogger };

// ── console.warn redirection ────────────────────────────────────────────────

// Suppress third-party deprecation warnings (Octokit emits them via
// process.emitWarning) — route them to the file log instead of stderr.
// Matched on octokit mentions or Node's DeprecationWarning envelope, not the
// bare word "deprecated", so unrelated warns pass through untouched.
function hijackWarn(): void {
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    const msg = args.map(a => String(a)).join(' ');
    if (msg.includes('octokit') || /DeprecationWarning/.test(msg)) {
      fileLogger.warn({ source: 'octokit' }, msg);
    } else {
      originalWarn.apply(console, args);
    }
  };
}
hijackWarn();

/**
 * Daemon mode: route ALL process output onto the day log so user-facing
 * output (banners, status lines) lands in the same unified file as pino
 * diagnostics and follows the date rotation. Two paths must both be covered:
 *
 * - console.* writes to the stream the global console captured at startup,
 *   so the console itself has to be swapped (reassigning process.stdout is
 *   NOT enough);
 * - direct process.stdout.write calls (loop status lines) need the property
 *   reassigned.
 *
 * Call this first thing in the daemon's command action, before any output.
 */
export function redirectStdioToLog(): void {
  globalThis.console = new Console({
    stdout: dayLog as unknown as NodeJS.WritableStream,
    stderr: dayLog as unknown as NodeJS.WritableStream,
  });
  // process.stdout/stderr are getter-only in modern Node (assignment throws
  // in strict-mode ESM) — redefine them to point at the day log. Direct
  // process.stdout.write calls (loop status lines) pick this up at call time.
  Object.defineProperty(process, 'stdout', {
    value: dayLog,
    configurable: true,
  });
  Object.defineProperty(process, 'stderr', {
    value: dayLog,
    configurable: true,
  });
  hijackWarn();
}
