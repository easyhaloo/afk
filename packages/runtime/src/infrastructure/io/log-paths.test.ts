import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LOG_RETENTION_DAYS,
  pruneStaleLogs,
  resolveLogDir,
  resolveLogPath,
  resolveQaTimeoutSnapshotDir,
  resolveTimeoutSnapshotDir,
  resolveWatchdogLogPath,
} from './log-paths.js';

const previousLogDir = process.env.AFK_LOG_DIR;

afterEach(() => {
  if (previousLogDir === undefined) delete process.env.AFK_LOG_DIR;
  else process.env.AFK_LOG_DIR = previousLogDir;
});

describe('log paths', () => {
  it('defaults every destination under ~/.afk/logs', () => {
    delete process.env.AFK_LOG_DIR;
    const root = join(homedir(), '.afk', 'logs');
    expect(resolveLogDir()).toBe(root);
    expect(resolveLogPath(new Date('2026-10-22T12:00:00'))).toBe(join(root, 'afk-2026-10-22.log'));
    expect(resolveTimeoutSnapshotDir()).toBe(join(root, 'timeout'));
    expect(resolveQaTimeoutSnapshotDir()).toBe(join(root, 'qa'));
    expect(resolveWatchdogLogPath()).toBe(join(root, 'watchdog.log'));
  });

  it('moves the whole tree together when AFK_LOG_DIR overrides the root', () => {
    process.env.AFK_LOG_DIR = '/tmp/afk-logs';
    expect(resolveLogDir()).toBe('/tmp/afk-logs');
    expect(resolveLogPath(new Date('2026-10-22T12:00:00'))).toBe('/tmp/afk-logs/afk-2026-10-22.log');
    expect(resolveTimeoutSnapshotDir()).toBe('/tmp/afk-logs/timeout');
    expect(resolveQaTimeoutSnapshotDir()).toBe('/tmp/afk-logs/qa');
    expect(resolveWatchdogLogPath()).toBe('/tmp/afk-logs/watchdog.log');
  });

  it('ignores a blank override so an empty env var cannot break logging', () => {
    process.env.AFK_LOG_DIR = '   ';
    expect(resolveLogDir()).toBe(join(homedir(), '.afk', 'logs'));
  });

  it('prunes day logs and snapshots past the retention window and keeps fresh ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'afk-log-paths-'));
    try {
      process.env.AFK_LOG_DIR = root;
      const stale = (Date.now() - (LOG_RETENTION_DAYS + 1) * 24 * 3600 * 1000) / 1000;

      mkdirSync(resolveTimeoutSnapshotDir(), { recursive: true });
      mkdirSync(resolveQaTimeoutSnapshotDir(), { recursive: true });
      const dayLog = resolveLogPath(new Date('2026-10-01T12:00:00'));
      const staleSnapshot = join(resolveTimeoutSnapshotDir(), 'timeout-1-1.log');
      const freshSnapshot = join(resolveQaTimeoutSnapshotDir(), 'timeout-2-2.log');
      writeFileSync(dayLog, 'stale');
      writeFileSync(staleSnapshot, 'stale');
      writeFileSync(freshSnapshot, 'fresh');
      utimesSync(dayLog, stale, stale);
      utimesSync(staleSnapshot, stale, stale);

      pruneStaleLogs();

      expect(existsSync(dayLog)).toBe(false);
      expect(existsSync(staleSnapshot)).toBe(false);
      expect(existsSync(freshSnapshot)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
