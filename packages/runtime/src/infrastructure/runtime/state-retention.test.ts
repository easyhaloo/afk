import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RETENTION_POLICY, pruneRuntimeState } from './state-retention.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-11-05T00:00:00.000Z');

describe('runtime state retention', () => {
  let root: string;
  let archived: string;
  let diagnostics: string;

  /** Write a file whose modification time is `daysAgo` before the fixed now. */
  const agedFile = (directory: string, name: string, daysAgo: number): string => {
    mkdirSync(directory, { recursive: true });
    const path = join(directory, name);
    writeFileSync(path, '{}', 'utf8');
    const at = (NOW.getTime() - daysAgo * DAY_MS) / 1000;
    utimesSync(path, at, at);
    return path;
  };

  const agedDirectory = (directory: string, name: string, daysAgo: number): string => {
    const path = join(directory, name);
    mkdirSync(path, { recursive: true });
    const at = (NOW.getTime() - daysAgo * DAY_MS) / 1000;
    utimesSync(path, at, at);
    return path;
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'afk-retention-'));
    archived = join(root, 'archive');
    diagnostics = join(root, 'diagnostics');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const prune = (policy: Partial<typeof DEFAULT_RETENTION_POLICY> = {}) => pruneRuntimeState({
    tasksRoot: root,
    now: () => NOW,
    policy,
  });

  it('drops finished-run records past the window and keeps the rest', async () => {
    const stale = agedFile(archived, 'run-old.json', 8);
    const fresh = agedFile(archived, 'run-new.json', 6);
    const unrelated = agedFile(archived, 'notes.txt', 30);

    const report = await prune({ taskHistoryMs: 7 * DAY_MS });

    expect(report.archivedRecords).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it('drops diagnostic snapshots past the window', async () => {
    const stale = agedDirectory(diagnostics, 'run-old', 8);
    const fresh = agedDirectory(diagnostics, 'run-new', 2);

    const report = await prune({ diagnosticsMs: 7 * DAY_MS });

    expect(report.diagnosticDirectories).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it('removes nothing when a window is disabled', async () => {
    const stale = agedFile(archived, 'run-old.json', 400);

    const report = await prune({ taskHistoryMs: 0, diagnosticsMs: 0 });

    expect(report.archivedRecords).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });

  it('treats a missing store as empty instead of failing', async () => {
    const report = await pruneRuntimeState({ tasksRoot: join(root, 'absent'), now: () => NOW });

    expect(report).toEqual({ archivedRecords: 0, diagnosticDirectories: 0 });
  });
});
