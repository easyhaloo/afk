import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { assertKnowledgeDirectory } from './knowledge.js';
import { canonicalLearningJson } from './requests.js';

const savedPath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value));
const bytesDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');

export function readValidationSnapshotFile(file: string, root: string, limit: number,
  expectedSource?: Readonly<Pick<BigIntStats, 'dev' | 'ino'>>): Buffer {
  savedPath.parse(file);
  savedPath.parse(root);
  z.number().int().positive().safe().max(64 * 1024 * 1024).parse(limit);
  const location = relative(root, file);
  if (!location || isAbsolute(location) || location === '..' || location.startsWith(`..${sep}`)) throw new Error('snapshot_outside_root');
  assertKnowledgeDirectory(dirname(file));
  if (realpathSync(root) !== root || realpathSync(file) !== file) throw new Error('snapshot_unsafe_path');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > limit) throw new Error('snapshot_unavailable');
    if (expectedSource) {
      const opened = fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.dev !== expectedSource.dev || opened.ino !== expectedSource.ino
        || opened.nlink !== 1n || (opened.mode & 0o022n) !== 0n
        || (process.getuid && opened.uid !== BigInt(process.getuid()))) throw new Error('snapshot_changed');
    }
    const bytes = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const fingerprint = (stats: typeof before) => canonicalLearningJson([stats.dev, stats.ino, stats.size, stats.mode,
      stats.uid, stats.nlink, stats.mtimeMs, stats.ctimeMs]);
    const current = lstatSync(file);
    if (offset !== before.size || current.isSymbolicLink() || fingerprint(before) !== fingerprint(fstatSync(descriptor))
      || fingerprint(before) !== fingerprint(current) || realpathSync(file) !== file) throw new Error('snapshot_changed');
    assertKnowledgeDirectory(dirname(file));
    return bytes.subarray(0, offset);
  } finally { closeSync(descriptor); }
}

export function readValidationPrivateFile(file: string): { bytes: Buffer; fingerprint: string; identityFingerprint: string } {
  savedPath.parse(file);
  assertKnowledgeDirectory(dirname(file));
  const parent = lstatSync(dirname(file));
  const parentIdentity = (stats: typeof parent) => canonicalLearningJson([stats.dev, stats.ino, stats.mode, stats.uid]);
  if ((parent.mode & 0o077) || (process.getuid && parent.uid !== process.getuid())) throw new Error('private_file_required');
  const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024 || (before.mode & 0o077)
      || (process.getuid && before.uid !== process.getuid())) throw new Error('private_file_required');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const fingerprint = (stats: typeof before) => canonicalLearningJson([stats.dev, stats.ino, stats.size, stats.mode,
      stats.uid, stats.nlink, stats.mtimeMs, stats.ctimeMs]);
    const after = lstatSync(file);
    if (offset !== before.size || after.isSymbolicLink() || fingerprint(before) !== fingerprint(fstatSync(descriptor))
      || fingerprint(before) !== fingerprint(after)) throw new Error('private_file_changed');
    assertKnowledgeDirectory(dirname(file));
    if (parentIdentity(parent) !== parentIdentity(lstatSync(dirname(file)))) throw new Error('private_file_changed');
    const bytes = buffer.subarray(0, offset);
    const contentFingerprint = digest([fingerprint(before), bytesDigest(bytes)]);
    return { bytes, fingerprint: contentFingerprint, identityFingerprint: digest([contentFingerprint, parentIdentity(parent)]) };
  } finally { closeSync(descriptor); }
}
