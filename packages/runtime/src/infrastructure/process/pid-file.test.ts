import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mkdtempSync } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_LOOP_RUN_TAG,
  MAX_LOOP_RUN_TAG_LENGTH,
  legacyLoopPathOverrides,
  liveLoopRunTags,
  loopPidFilePath,
  loopRunDirectory,
  loopRunTagForWorkItem,
  loopRunsDirectory,
  loopStatusFilePath,
  removeLoopPidFiles,
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

  it('derives a short, stable tag from a work item id', () => {
    const tag = loopRunTagForWorkItem('gitlab:w.src.corp.qihoo.net/fang/services/k-base#3');
    expect(tag).toMatch(/^k-base-3-[0-9a-f]{6}$/);
    expect(loopRunTagForWorkItem('gitlab:w.src.corp.qihoo.net/fang/services/k-base#3')).toBe(tag);
    expect(loopRunTagForWorkItem('github:acme/api#42')).toMatch(/^api-42-[0-9a-f]{6}$/);
  });

  it('keeps the identity suffix when a long project name exhausts the tag', () => {
    const long = 'a'.repeat(80);
    const first = loopRunTagForWorkItem(`gitlab:host/group/${long}#1`);
    const second = loopRunTagForWorkItem(`gitlab:host/group/${long}#12`);
    expect(first).toHaveLength(MAX_LOOP_RUN_TAG_LENGTH);
    expect(second).toHaveLength(MAX_LOOP_RUN_TAG_LENGTH);
    expect(first).not.toBe(second);
    expect(first).not.toMatch(/-$/);
    expect(first.slice(-6)).toMatch(/^[0-9a-f]{6}$/);
  });

  it('keeps the same project path on two instances in different runs', () => {
    const corporate = loopRunTagForWorkItem('gitlab:git.corp/group/project#3');
    const hosted = loopRunTagForWorkItem('gitlab:gitlab.com/group/project#3');
    expect(corporate).not.toBe(hosted);
    expect(corporate.startsWith('project-3-')).toBe(true);
    expect(hosted.startsWith('project-3-')).toBe(true);
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

describe('removing pid files', () => {
  it('keeps the legacy pid file of a loop that is still running', () => {
    const pidFile = path.join(runsRoot(), 'default', 'loop.pid');
    const legacyPidFile = path.join(runsRoot(), 'legacy-loop.pid');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, '99999999\n');
    fs.writeFileSync(legacyPidFile, `${process.pid}\n`);

    const removed = removeLoopPidFiles({ pidFile, legacyPidFile });

    // Cleaning a stale default run must not orphan a live pre-upgrade loop.
    expect(removed).toEqual([pidFile]);
    expect(fs.existsSync(pidFile)).toBe(false);
    expect(fs.existsSync(legacyPidFile)).toBe(true);
  });

  it('removes the legacy pid file once its process is gone', () => {
    const pidFile = path.join(runsRoot(), 'default', 'loop.pid');
    const legacyPidFile = path.join(runsRoot(), 'legacy-loop.pid');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(legacyPidFile, '99999999\n');

    const removed = removeLoopPidFiles({ pidFile, legacyPidFile });

    expect(removed).toEqual([legacyPidFile]);
    expect(fs.existsSync(legacyPidFile)).toBe(false);
  });

  it('leaves the legacy pid file alone when the run is not the default', () => {
    const pidFile = path.join(runsRoot(), 'k-base-3', 'loop.pid');
    const legacyPidFile = path.join(runsRoot(), 'legacy-loop.pid');
    fs.mkdirSync(path.dirname(pidFile), { recursive: true });
    fs.writeFileSync(pidFile, '99999999\n');
    fs.writeFileSync(legacyPidFile, '99999999\n');

    const removed = removeLoopPidFiles({ pidFile });

    expect(removed).toEqual([pidFile]);
    expect(fs.existsSync(legacyPidFile)).toBe(true);
  });
});
