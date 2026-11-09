import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONTEXT_MAX_CHARS, writeReferenceContext } from './context-file.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('bounded reference context', () => {
  it('keeps sources, caps file size and replaces a target symlink without following it', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'context-reference-'));
    roots.push(root);
    await fs.mkdir(join(root, '.afk'));
    const outside = join(root, 'outside.md');
    await fs.writeFile(outside, 'unchanged');
    await fs.symlink(outside, join(root, '.afk', 'plugin-context.md'));
    const path = await writeReferenceContext(root, 'plugin-context.md', [{ origin: 'code:test', content: 'bounded '.repeat(8000) }]);
    const content = await fs.readFile(join(root, path), 'utf8');
    expect(content.length).toBeLessThanOrEqual(CONTEXT_MAX_CHARS);
    expect(content).toContain('Source: code:test');
    expect(await fs.readFile(outside, 'utf8')).toBe('unchanged');
    expect((await fs.lstat(join(root, path))).isSymbolicLink()).toBe(false);
  });

  it('rejects a context directory that links outside the worktree', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'context-reference-'));
    roots.push(root);
    const outside = join(root, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, join(root, '.afk'));
    await expect(writeReferenceContext(root, 'experience-context.md', [])).rejects.toThrow('symbolic link');
    expect(await fs.readdir(outside)).toEqual([]);
  });
});
