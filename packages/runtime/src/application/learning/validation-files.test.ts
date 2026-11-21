import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readValidationPrivateFile, readValidationSnapshotFile } from './validation-files.js';

let root: string;
let file: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'validation-file-')));
  file = join(root, 'input.json');
  writeFileSync(file, '{"version":1}', { mode: 0o600 });
});
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

describe('shared validation file reads', () => {
  it.each(['hardlink', 'replacement'] as const)('reads no bytes from a %s substituted at open', replacement => {
    const authorized = join(root, 'authorized');
    mkdirSync(authorized, { mode: 0o700 });
    const source = join(authorized, 'source.json');
    writeFileSync(source, '{}', { mode: 0o600 });
    const expected = fs.lstatSync(source, { bigint: true });
    const sentinel = join(root, 'private-sentinel.json');
    writeFileSync(sentinel, 'PRIVATE_OUTSIDE_SENTINEL', { mode: 0o600 });
    const nativeOpen = fs.openSync;
    const nativeRead = fs.readSync;
    let descriptor: number | undefined;
    let bytes = 0;
    vi.spyOn(fs, 'openSync').mockImplementation((...parameters: Parameters<typeof fs.openSync>) => {
      if (String(parameters[0]) === source) {
        renameSync(source, join(root, 'original.json'));
        if (replacement === 'hardlink') linkSync(sentinel, source);
        else renameSync(sentinel, source);
        descriptor = nativeOpen(...parameters);
        return descriptor;
      }
      return nativeOpen(...parameters);
    });
    vi.spyOn(fs, 'readSync').mockImplementation((...parameters: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(nativeRead, fs, parameters);
      if (parameters[0] === descriptor) bytes += count;
      return count;
    });
    syncBuiltinESMExports();
    expect(() => readValidationSnapshotFile(source, authorized, 100, expected)).toThrow();
    expect(bytes).toBe(0);
    expect(descriptor).toBeDefined();
    expect(() => fs.fstatSync(descriptor!)).toThrow();
  });

  it('accepts the pinned source inode without relaxing size or write protection', () => {
    const expected = fs.lstatSync(file, { bigint: true });
    expect(readValidationSnapshotFile(file, root, 100, expected).toString()).toBe('{"version":1}');
    expect(() => readValidationSnapshotFile(file, root, 12, expected)).toThrow('snapshot_unavailable');
    chmodSync(file, 0o660);
    expect(() => readValidationSnapshotFile(file, root, 100, expected)).toThrow('snapshot_changed');
  });

  it('preserves bytes and a stable private fingerprint while detecting replacement', () => {
    const before = readValidationPrivateFile(file);
    expect(before.bytes.toString('utf8')).toBe('{"version":1}');
    expect(readValidationPrivateFile(file)).toEqual(before);
    const next = join(root, 'next.json');
    writeFileSync(next, before.bytes, { mode: 0o600 });
    renameSync(next, file);
    expect(readValidationPrivateFile(file).fingerprint).not.toBe(before.fingerprint);
  });

  it.each([0o640, 0o644, 0o660])('rejects private files with permissions %s', mode => {
    chmodSync(file, mode);
    expect(() => readValidationPrivateFile(file)).toThrow('private_file_required');
  });

  it('rejects a shared parent and hardlinked private files', () => {
    chmodSync(root, 0o750);
    expect(() => readValidationPrivateFile(file)).toThrow('private_file_required');
    chmodSync(root, 0o700);
    linkSync(file, join(root, 'hardlink.json'));
    expect(() => readValidationPrivateFile(file)).toThrow('private_file_required');
  });

  it('rejects symbolic files and parent directories', () => {
    const linked = join(root, 'linked.json');
    symlinkSync(file, linked);
    expect(() => readValidationPrivateFile(linked)).toThrow();
    expect(() => readValidationSnapshotFile(linked, root, 100)).toThrow();
    const actual = join(root, 'actual');
    mkdirSync(actual, { mode: 0o700 });
    writeFileSync(join(actual, 'input.json'), '{}', { mode: 0o600 });
    symlinkSync(actual, join(root, 'parent'));
    expect(() => readValidationPrivateFile(join(root, 'parent', 'input.json'))).toThrow();
  });

  it('refuses oversized private input and bounds public snapshot bytes', () => {
    expect(readValidationSnapshotFile(file, root, 13).toString()).toBe('{"version":1}');
    expect(() => readValidationSnapshotFile(file, root, 12)).toThrow('snapshot_unavailable');
    writeFileSync(file, Buffer.alloc(1024 * 1024 + 1));
    expect(() => readValidationPrivateFile(file)).toThrow('private_file_required');
  });

  it.each([0, -1, NaN, Infinity, 64 * 1024 * 1024 + 1])('rejects an invalid snapshot limit (%s)', limit => {
    expect(() => readValidationSnapshotFile(file, root, limit)).toThrow();
  });

  it('rejects snapshots outside the authorized root and non-file paths', () => {
    const subtree = join(root, 'subtree');
    mkdirSync(subtree);
    expect(() => readValidationSnapshotFile(file, subtree, 100)).toThrow('snapshot_outside_root');
    expect(() => readValidationSnapshotFile(root, root, 100)).toThrow('snapshot_outside_root');
    expect(() => readValidationPrivateFile(subtree)).toThrow('private_file_required');
  });
});
