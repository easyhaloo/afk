import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildFrozenContext, captureFrozenInput, replaceFrozenFile } from './frozen-input.js';

const roots: string[] = [];
const directory = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-frozen-input-')));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const baseImageId = `sha256:${'a'.repeat(64)}`;

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
