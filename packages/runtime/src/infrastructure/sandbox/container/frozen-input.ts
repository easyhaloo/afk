import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

export interface FrozenInputEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly mode: number;
  readonly size: number;
  readonly digest: string;
}

export interface CapturedFrozenInput {
  readonly manifest: readonly FrozenInputEntry[];
  readonly digest: string;
}

const captured = new WeakMap<CapturedFrozenInput, ReadonlyMap<string, Buffer>>();
export interface CapturedFrozenScratchHelper {
  readonly digest: string;
  readonly architecture: 'arm64' | 'x64';
}

const helpers = new WeakMap<CapturedFrozenScratchHelper, Buffer>();

export function assertFrozenScratchHelper(helper: CapturedFrozenScratchHelper): void {
  if (!helpers.has(helper)) throw new Error('Frozen scratch helper is not owned by this adapter');
}

export function captureFrozenScratchHelper(path: string, expectedDigest: string): CapturedFrozenScratchHelper {
  if (!/^[a-f0-9]{64}$/.test(expectedDigest) || resolve(path) !== path || realpathSync(path) !== path) throw new Error('Invalid frozen scratch helper provenance');
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size < 64 || before.size > 2 * 1024 * 1024) throw new Error('Invalid frozen scratch helper file');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const received = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
      if (!received) break;
      offset += received;
    }
    const bytes = buffer.subarray(0, offset);
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink() || realpathSync(path) !== path
      || digest(bytes) !== expectedDigest) throw new Error('Frozen scratch helper changed or digest differs');
    if (!bytes.subarray(0, 7).equals(Buffer.from([127, 69, 76, 70, 2, 1, 1])) || bytes.readUInt16LE(16) !== 2
      || ![62, 183].includes(bytes.readUInt16LE(18))) throw new Error('Frozen scratch helper must be a static Linux ELF64 executable');
    const programOffset = Number(bytes.readBigUInt64LE(32));
    const programCount = bytes.readUInt16LE(56);
    if (!Number.isSafeInteger(programOffset) || programOffset < 64 || !programCount || programCount > 64 || bytes.readUInt16LE(54) !== 56
      || programOffset + programCount * 56 > bytes.length) throw new Error('Invalid frozen scratch helper ELF program table');
    for (let index = 0; index < programCount; index++) {
      if ([2, 3].includes(bytes.readUInt32LE(programOffset + index * 56))) throw new Error('Dynamic frozen scratch helper is forbidden');
    }
    const helper = Object.freeze({ digest: expectedDigest, architecture: bytes.readUInt16LE(18) === 183 ? 'arm64' as const : 'x64' as const });
    helpers.set(helper, Buffer.from(bytes));
    return helper;
  } finally { closeSync(descriptor); }
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const maxBytes = 8 * 1024 * 1024;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason;
}

function safePath(path: string): void {
  if (!path || Buffer.byteLength(`input/${path}`) > 99 || /[\x00-\x1f\x7f\\]/.test(path) || isAbsolute(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || part === '.git')) throw new Error('Unsafe frozen input path');
}

function seal(manifest: FrozenInputEntry[], files: Map<string, Buffer>): CapturedFrozenInput {
  manifest.sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0);
  const frozen = Object.freeze(manifest.map(entry => Object.freeze({ ...entry })));
  const input = Object.freeze({ manifest: frozen, digest: digest(JSON.stringify(frozen)) });
  captured.set(input, files);
  return input;
}

export function captureFrozenInput(root: string, options: { signal?: AbortSignal; paths?: readonly string[] } = {}): CapturedFrozenInput {
  checkAbort(options.signal);
  const selected = options.paths && new Set(options.paths);
  const children = new Map<string, Set<string>>();
  for (const path of selected ?? []) {
    safePath(path);
    let parent = '';
    for (const name of path.split('/')) {
      if (!children.has(parent)) children.set(parent, new Set());
      children.get(parent)!.add(name);
      parent = parent ? `${parent}/${name}` : name;
    }
  }
  if (resolve(root) !== root || realpathSync(root) !== root || !lstatSync(root).isDirectory()) throw new Error('Frozen input root must be a canonical directory');
  const manifest: FrozenInputEntry[] = [];
  const files = new Map<string, Buffer>();
  let total = 0;
  let count = 0;
  const visit = (directory: string, prefix: string, depth: number) => {
    checkAbort(options.signal);
    if (depth > 32) throw new Error('Frozen input depth limit exceeded');
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || realpathSync(directory) !== directory) throw new Error('Frozen input directory changed');
    const names: string[] = [];
    if (selected) names.push(...(children.get(prefix) ?? []));
    else {
      const handle = opendirSync(directory);
      try {
        for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
          if (names.length >= 1024 - count) throw new Error('Frozen input entry limit exceeded');
          names.push(entry.name);
        }
      } finally { handle.closeSync(); }
    }
    for (const name of names.sort()) {
      checkAbort(options.signal);
      if (++count > 1024) throw new Error('Frozen input entry limit exceeded');
      const path = prefix ? `${prefix}/${name}` : name;
      const source = join(directory, name);
      const metadata = lstatSync(source);
      if (metadata.isSymbolicLink()) throw new Error('Frozen input symlink is forbidden');
      if (name === '.git') {
        if (!metadata.isDirectory() && !metadata.isFile()) throw new Error('Unsafe repository metadata');
        continue;
      }
      safePath(path);
      if (selected && (metadata.isDirectory() ? selected.has(path) : children.has(path))) throw new Error('Frozen input selection must contain only files');
      if (metadata.isDirectory()) {
        manifest.push({ path, kind: 'directory', mode: 0o555, size: 0, digest: digest('') });
        visit(source, path, depth + 1);
      } else {
        if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > maxBytes - total) throw new Error('Frozen input file type or size limit exceeded');
        const descriptor = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        let bytes: Buffer;
        try {
          const opened = fstatSync(descriptor);
          if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev || opened.ino !== metadata.ino || opened.size !== metadata.size) throw new Error('Frozen input file changed');
          const buffer = Buffer.alloc(opened.size + 1);
          let offset = 0;
          while (offset < buffer.length) {
            checkAbort(options.signal);
            const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset);
            if (!count) break;
            offset += count;
          }
          bytes = buffer.subarray(0, offset);
          const after = fstatSync(descriptor);
          const current = lstatSync(source);
          if (after.size !== opened.size || bytes.length !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
            || current.ino !== opened.ino || current.dev !== opened.dev || current.isSymbolicLink()
            || realpathSync(source) !== source) throw new Error('Frozen input changed during capture');
        } finally { closeSync(descriptor); }
        total += bytes.length;
        if (total > maxBytes) throw new Error('Frozen input byte limit exceeded');
        files.set(path, bytes);
        manifest.push({ path, kind: 'file', mode: metadata.mode & 0o111 ? 0o555 : 0o444, size: bytes.length, digest: digest(bytes) });
      }
    }
    const after = lstatSync(directory);
    if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('Frozen input directory changed during capture');
  };
  visit(root, '', 0);
  checkAbort(options.signal);
  return seal(manifest, files);
}

export function replaceFrozenFile(input: CapturedFrozenInput, path: string, content: Buffer): CapturedFrozenInput {
  safePath(path);
  const source = captured.get(input);
  if (!source) throw new Error('Frozen input is not owned by this adapter');
  const existing = input.manifest.find(entry => entry.path === path);
  if (existing?.kind === 'directory') throw new Error('Cannot replace a frozen directory');
  if (!existing && path.includes('/') && !input.manifest.some(entry => entry.path === path.slice(0, path.lastIndexOf('/')) && entry.kind === 'directory')) throw new Error('Frozen artifact parent is unavailable');
  const bytes = Buffer.from(content);
  const manifest = input.manifest.filter(entry => entry.path !== path).map(entry => ({ ...entry }));
  manifest.push({ path, kind: 'file', mode: existing?.mode ?? 0o444, size: bytes.length, digest: digest(bytes) });
  if (manifest.length > 1024 || manifest.reduce((sum, entry) => sum + entry.size, 0) > maxBytes) throw new Error('Frozen input limit exceeded');
  return seal(manifest, new Map([...source, [path, bytes]]));
}

export function selectFrozenFiles(input: CapturedFrozenInput, paths: readonly string[]): CapturedFrozenInput {
  const source = captured.get(input);
  if (!source) throw new Error('Frozen input is not owned by this adapter');
  const included = new Set<string>();
  const files = new Map<string, Buffer>();
  for (const path of paths) {
    const bytes = source.get(path);
    if (!bytes) throw new Error('Selected frozen file is unavailable');
    files.set(path, bytes);
    included.add(path);
    for (let parent = path.lastIndexOf('/'); parent >= 0; parent = path.lastIndexOf('/', parent - 1)) {
      included.add(path.slice(0, parent));
    }
  }
  return seal(input.manifest.filter(entry => included.has(entry.path)), files);
}

function tarEntry(path: string, bytes: Buffer, mode: number, directory = false): Buffer {
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, 'utf8');
  const octal = (value: number, offset: number, length: number) => header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii');
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(bytes.length, 124, 12);
  octal(0, 136, 12);
  header.fill(32, 148, 156);
  header.write(directory ? '5' : '0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512)]);
}

export function buildFrozenContext(input: CapturedFrozenInput, baseImageId: string, operationId?: string, helper?: CapturedFrozenScratchHelper): { archive: Buffer; digest: string; dockerfile: string } {
  if (!/^sha256:[a-f0-9]{64}$/.test(baseImageId)) throw new Error('Frozen base image must be an exact image ID');
  const files = captured.get(input);
  if (!files) throw new Error('Frozen input is not owned by this adapter');
  if (operationId !== undefined && !/^[a-f0-9-]{36}$/.test(operationId)) throw new Error('Invalid frozen build ownership');
  const ownership = operationId ? `LABEL afk.frozen.managed="true" afk.frozen.operation="${operationId}"\n` : '';
  if (helper) assertFrozenScratchHelper(helper);
  const dockerfile = `FROM ${baseImageId}\n${ownership}COPY input/ /workspace/\n${helper ? 'COPY observer/ /afk-observer/\n' : ''}`;
  const entries = [tarEntry('Dockerfile', Buffer.from(dockerfile), 0o444), tarEntry('input/', Buffer.alloc(0), 0o555, true)];
  if (helper) entries.push(tarEntry('observer/', Buffer.alloc(0), 0o555, true), tarEntry('observer/scratch-v1', helpers.get(helper)!, 0o555));
  for (const entry of input.manifest) entries.push(tarEntry(`input/${entry.path}${entry.kind === 'directory' ? '/' : ''}`, files.get(entry.path) ?? Buffer.alloc(0), entry.mode, entry.kind === 'directory'));
  const archive = Buffer.concat([...entries, Buffer.alloc(1024)]);
  return { archive, digest: digest(archive), dockerfile };
}
