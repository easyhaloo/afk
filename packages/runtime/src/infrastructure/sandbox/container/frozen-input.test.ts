import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFrozenScratchHelper, buildFrozenContext, captureFrozenInput, captureFrozenScratchHelper, replaceFrozenFile } from './frozen-input.js';

const roots: string[] = [];
const directory = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-frozen-input-')));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const baseImageId = `sha256:${'a'.repeat(64)}`;

function helperBytes(machine = 183, programType = 1): Buffer {
  const bytes = Buffer.alloc(120);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(machine, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(programType, 64);
  return bytes;
}

describe('captured native scratch helper', () => {
  it('captures private immutable bytes in a separate context path and refuses forged handles', () => {
    const root = directory();
    const helperPath = join(root, 'helper');
    const bytes = helperBytes();
    const expectedDigest = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(helperPath, bytes);
    const helper = captureFrozenScratchHelper(helperPath, expectedDigest);
    expect(Object.isFrozen(helper)).toBe(true);
    expect(helper).toEqual({ digest: expectedDigest, architecture: 'arm64' });
    expect(() => assertFrozenScratchHelper(JSON.parse(JSON.stringify(helper)))).toThrow(/owned/);
    const inputRoot = directory();
    writeFileSync(join(inputRoot, 'scratch-v1'), 'candidate cannot replace native helper');
    const input = captureFrozenInput(inputRoot);
    const ordinary = buildFrozenContext(input, baseImageId);
    const observed = buildFrozenContext(input, baseImageId, undefined, helper);
    expect(observed.archive.includes(bytes)).toBe(true);
    expect(observed.archive.includes(Buffer.from('observer/scratch-v1'))).toBe(true);
    expect(observed.dockerfile).toContain('COPY observer/ /afk-observer/');
    expect(ordinary.dockerfile).not.toContain('observer/');
    expect(observed.digest).not.toBe(ordinary.digest);
    writeFileSync(helperPath, 'changed after capture');
    expect(buildFrozenContext(input, baseImageId, undefined, helper).archive.equals(observed.archive)).toBe(true);
    expect(() => buildFrozenContext(input, baseImageId, undefined, { ...helper })).toThrow(/owned/);
    expect(input.digest).toBe(createHash('sha256').update(JSON.stringify(input.manifest)).digest('hex'));
  });

  it.each([2, 3])('rejects a dynamic program table entry %s despite a matching digest', programType => {
    const bytes = helperBytes(62, programType);
    const path = join(directory(), 'helper');
    writeFileSync(path, bytes);
    expect(() => captureFrozenScratchHelper(path, createHash('sha256').update(bytes).digest('hex'))).toThrow(/Dynamic/);
  });

  it('rejects symlinks, hardlinks, wrong digest, unsupported ELF and oversized bytes', () => {
    const root = directory();
    const path = join(root, 'helper');
    const bytes = helperBytes(62);
    const hash = createHash('sha256').update(bytes).digest('hex');
    writeFileSync(path, bytes);
    expect(captureFrozenScratchHelper(path, hash).architecture).toBe('x64');
    expect(() => captureFrozenScratchHelper(path, '0'.repeat(64))).toThrow(/digest/);
    symlinkSync(path, join(root, 'symbolic'));
    expect(() => captureFrozenScratchHelper(join(root, 'symbolic'), hash)).toThrow(/provenance/);
    linkSync(path, join(root, 'hard'));
    expect(() => captureFrozenScratchHelper(path, hash)).toThrow(/file/);
    rmSync(join(root, 'hard'));
    const unsupported = helperBytes(40);
    writeFileSync(path, unsupported);
    expect(() => captureFrozenScratchHelper(path, createHash('sha256').update(unsupported).digest('hex'))).toThrow(/ELF/);
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024 + 1));
    expect(() => captureFrozenScratchHelper(path, hash)).toThrow(/file/);
  });
});

describe('captured frozen input', () => {
  it('preserves an explicitly null cancellation reason before capturing any bytes', () => {
    let caught: unknown = 'not thrown';
    try { captureFrozenInput(directory(), { signal: AbortSignal.abort(null) }); } catch (error) { caught = error; }
    expect(caught).toBe(null);
  });
  it('builds only from captured bytes and replaces only the selected asset', () => {
    const root = directory();
    writeFileSync(join(root, 'helper.js'), 'original-helper');
    writeFileSync(join(root, 'asset.js'), 'original-asset');
    const input = captureFrozenInput(root);
    const original = buildFrozenContext(input, baseImageId);
    writeFileSync(join(root, 'helper.js'), 'hostile-helper');
    const repeated = buildFrozenContext(input, baseImageId);
    expect(repeated.archive.equals(original.archive)).toBe(true);
    const proposed = replaceFrozenFile(input, 'asset.js', Buffer.from('proposed-asset'));
    expect(proposed.manifest.find(entry => entry.path === 'helper.js')).toEqual(input.manifest.find(entry => entry.path === 'helper.js'));
    expect(buildFrozenContext(proposed, baseImageId).archive.includes(Buffer.from('original-helper'))).toBe(true);
    expect(original.archive.includes(Buffer.from('hostile-helper'))).toBe(false);
    expect(input.digest).toBe(createHash('sha256').update(JSON.stringify(input.manifest)).digest('hex'));
    expect(readFileSync(join(root, 'asset.js'), 'utf8')).toBe('original-asset');
  });

  it('uses an implementation-owned recipe even if input includes a Dockerfile', () => {
    const root = directory();
    writeFileSync(join(root, 'Dockerfile'), 'RUN touch /untrusted');
    const context = buildFrozenContext(captureFrozenInput(root), baseImageId);
    expect(context.dockerfile).toContain(`FROM ${baseImageId}`);
    expect(context.dockerfile).not.toContain('RUN');
    expect(context.dockerfile).toContain('COPY input/ /workspace/');
    expect(() => buildFrozenContext(captureFrozenInput(root), 'node:latest')).toThrow(/image/i);
  });

  it.each(['../escape', '/absolute', '.git/config', 'nested/../escape', 'bad\nname'])('rejects unsafe replacement path %j', path => {
    const root = directory();
    writeFileSync(join(root, 'asset.js'), 'asset');
    expect(() => replaceFrozenFile(captureFrozenInput(root), path, Buffer.from('changed'))).toThrow();
  });

  it('rejects symlinks including excluded metadata and enforces capture limits', () => {
    const root = directory();
    symlinkSync(directory(), join(root, '.git'));
    expect(() => captureFrozenInput(root)).toThrow(/symlink/i);
    rmSync(join(root, '.git'));
    writeFileSync(join(root, 'large'), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(() => captureFrozenInput(root)).toThrow(/limit/i);
  });

  it('excludes repository internals without depending on live .git bytes', () => {
    const root = directory();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'config'), 'secret');
    writeFileSync(join(root, 'asset.js'), 'asset');
    expect(buildFrozenContext(captureFrozenInput(root), baseImageId).archive.includes(Buffer.from('secret'))).toBe(false);
  });

  it('preserves cancellation reason before reading the input tree', () => {
    const reason = new Error('cancel capture');
    const controller = new AbortController();
    controller.abort(reason);
    expect(() => captureFrozenInput(directory(), { signal: controller.signal })).toThrow(reason);
  });

  it('rejects hardlinks and excessive directory entries', () => {
    const root = directory();
    writeFileSync(join(root, 'original'), 'original');
    linkSync(join(root, 'original'), join(root, 'alias'));
    expect(() => captureFrozenInput(root)).toThrow(/type|limit/i);
    rmSync(join(root, 'alias'));
    for (let index = 0; index < 1024; index++) writeFileSync(join(root, `entry-${index}`), '');
    expect(() => captureFrozenInput(root)).toThrow(/entry limit/i);
  });

  it('copies replacement buffers and refuses serialized or forged frozen handles', () => {
    const root = directory();
    writeFileSync(join(root, 'asset.js'), 'original');
    const input = captureFrozenInput(root);
    const replacement = Buffer.from('replacement');
    const proposed = replaceFrozenFile(input, 'asset.js', replacement);
    replacement.fill(0);
    expect(buildFrozenContext(proposed, baseImageId).archive.includes(Buffer.from('replacement'))).toBe(true);
    expect(() => buildFrozenContext(JSON.parse(JSON.stringify(input)), baseImageId)).toThrow(/owned/i);
  });
});
