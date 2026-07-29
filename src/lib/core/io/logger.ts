import pino from 'pino';
import pretty from 'pino-pretty';
import { join } from 'path';
import { homedir } from 'os';
import { mkdirSync } from 'fs';

const LOG_DIR = join(homedir(), '.afk');
const LOG_FILE = join(LOG_DIR, 'afk.log');

// Ensure log directory exists
try {
  mkdirSync(LOG_DIR, { recursive: true });
} catch {}

const isTest = process.env.NODE_ENV === 'test';
const level = isTest ? 'silent' : (process.env.LOG_LEVEL || 'info');

// Sync (non-worker) pretty streams: logs flush immediately and survive fast
// process exit, which the transport/worker form does not.
//
// Console stream -> stderr so diagnostic logs never pollute stdout that users
// pipe (e.g. `afk issue list | jq`). User-facing command output stays on
// console.log / process.stdout.
const prettyStream = pretty({
  colorize: true,
  translateTime: 'SYS:standard',
  ignore: 'pid,hostname',
  destination: process.stderr,
});

// File stream (appends, no color). Used when not a TTY (piped / daemon) and by
// the file-only logger.
const fileStream = pretty({
  colorize: false,
  destination: LOG_FILE,
  append: true,
  ignore: 'pid,hostname',
});

// Console logs go to stderr, so the TTY check must use stderr too: when the
// user pipes stdout (`afk issue list | jq`), stderr is still a TTY and
// warnings stay visible. Only when stderr is not a TTY (fully detached /
// redirected) do logs go to file.
const stream = process.stderr.isTTY ? prettyStream : fileStream;

export const logger = pino({ level }, stream);

// Separate file-only logger (always writes to file, no console output)
export const fileLogger = pino({ level }, fileStream);

// Suppress Octokit deprecation warnings - redirect to file logger
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  const msg = args.map(a => String(a)).join(' ');
  if (msg.includes('octokit/request') || msg.includes('deprecated')) {
    fileLogger.warn({ source: 'octokit' }, msg);
  } else {
    originalWarn.apply(console, args);
  }
};
