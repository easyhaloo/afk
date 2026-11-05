import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mkdtempSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_RUN_TAG,
  legacyLoopPathOverrides,
  liveLoopRunTags,
  loopPidFilePath,
  loopRunDirectory,
  loopRunTagForWorkItem,
  loopRunsDirectory,
  loopStatusFilePath,
  sanitizeLoopRunTag,
} from './pid-file.js';

const directories: string[] = [];

function runsRoot(): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'afk-loop-runs-'));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  while (directories.length) fs.rmSync(directories.pop() as string, { recursive: true, force: true });
});

describe('loop run tags', () => {
  it('keeps a name that is already a path segment', () => {
    expect(sanitizeLoopRunTag('k-base-3')).toBe('k-base-3');
    expect(sanitizeLoopRunTag('default')).toBe('default');
  });

  it('turns a raw identifier into one segment', () => {
    expect(sanitizeLoopRunTag('a/b c:d')).toBe('a-b-c-d');
    expect(sanitizeLoopRunTag('  spaced  ')).toBe('spaced');
  });

  it('refuses a tag that would leave the runs directory', () => {
    expect(() => sanitizeLoopRunTag('..')).toThrow(/invalid loop run tag/);
    expect(() => sanitizeLoopRunTag('.')).toThrow(/invalid loop run tag/);
    expect(() => sanitizeLoopRunTag('   ')).toThrow(/invalid loop run tag/);
  });

  it('derives a short tag from a work item id', () => {
    expect(loopRunTagForWorkItem('gitlab:w.src.corp.qihoo.net/fang/services/k-base#3')).toBe('k-base-3');
    expect(loopRunTagForWorkItem('github:acme/api#42')).toBe('api-42');
  });

  it('falls back to the default tag when no work item is named', () => {
    expect(loopRunTagForWorkItem(undefined)).toBe(DEFAULT_LOOP_RUN_TAG);
    expect(loopRunTagForWorkItem('#')).toBe(DEFAULT_LOOP_RUN_TAG);
  });
});

describe('loop run paths', () => {
  it('puts every run file under one tagged directory', () => {
    const root = runsRoot();
    const env = { AFK_LOOP_RUNS_DIR: root };
    expect(loopRunsDirectory(env)).toBe(root);
    expect(loopRunDirectory('k-base-3', env)).toBe(path.join(root, 'k-base-3'));
    expect(loopPidFilePath('k-base-3', env)).toBe(path.join(root, 'k-base-3', 'loop.pid'));
    expect(loopStatusFilePath('k-base-3', env)).toBe(path.join(root, 'k-base-3', 'status.json'));
    expect(loopStatusFilePath(undefined, env)).toBe(path.join(root, 'default', 'status.json'));
  });

  it('ignores the retired file overrides', () => {
    const root = runsRoot();
    const env = {
      AFK_LOOP_RUNS_DIR: root,
      AFK_LOOP_STATUS_FILE: '/tmp/elsewhere/status.json',
      AFK_LOOP_PID_FILE: '/tmp/elsewhere/loop.pid',
    };
    expect(loopStatusFilePath('default', env)).toBe(path.join(root, 'default', 'status.json'));
    expect(loopPidFilePath('default', env)).toBe(path.join(root, 'default', 'loop.pid'));
    expect(legacyLoopPathOverrides(env)).toEqual(['AFK_LOOP_PID_FILE', 'AFK_LOOP_STATUS_FILE']);
    expect(legacyLoopPathOverrides({})).toEqual([]);
  });

  it('reports only the tags whose recorded pid is alive', () => {
    const root = runsRoot();
    const env = { AFK_LOOP_RUNS_DIR: root };
    for (const [tag, pid] of [['live', process.pid], ['dead', 99_999_999]] as const) {
      fs.mkdirSync(path.join(root, tag), { recursive: true });
      fs.writeFileSync(path.join(root, tag, 'loop.pid'), `${pid}\n`);
    }
    expect(liveLoopRunTags(env)).toEqual(['live']);
  });
});
