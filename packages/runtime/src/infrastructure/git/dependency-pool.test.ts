import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DependencyPool, dependencyKey } from './dependency-pool.js';

async function project(root: string, name: string): Promise<string> {
  const path = join(root, name);
  await mkdir(join(path, 'packages/app'), { recursive: true });
  await writeFile(join(path, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  await writeFile(join(path, 'package.json'), '{"private":true}');
  await writeFile(join(path, 'packages/app/package.json'), '{"name":"@acme/app"}');
  return path;
}

describe('DependencyPool', () => {
  it('runs a real pnpm workspace from the pool after removing the original checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-pnpm-pool-'));
    const execute = promisify(execFile);
    try {
      const first = await project(root, 'first');
      const second = await project(root, 'second');
      for (const path of [first, second]) {
        await mkdir(join(path, 'packages/lib'), { recursive: true });
        await writeFile(join(path, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
        await writeFile(join(path, 'package.json'), '{"private":true}');
        await writeFile(join(path, 'packages/lib/package.json'), '{"name":"@acme/lib","version":"1.0.0","main":"index.cjs"}');
        await writeFile(join(path, 'packages/app/package.json'), JSON.stringify({ name: '@acme/app', dependencies: { '@acme/lib': 'workspace:*' },
          scripts: { check: 'node -e "if(require(\'@acme/lib\')!==43) process.exit(1)"' } }));
      }
      await writeFile(join(first, 'packages/lib/index.cjs'), 'module.exports = 42;');
      await writeFile(join(second, 'packages/lib/index.cjs'), 'module.exports = 43;');
      await rm(join(first, 'pnpm-lock.yaml'));
      await execute('pnpm', ['--dir', first, 'install', '--offline', '--ignore-scripts'], { env: { ...process.env, CI: 'true' }, timeout: 20_000 });
      await writeFile(join(second, 'pnpm-lock.yaml'), await readFile(join(first, 'pnpm-lock.yaml')));
      const pool = new DependencyPool(join(root, 'pool'));
      expect(await pool.capture(first)).toBe(true);
      await pool.release(first);
      await rm(first, { recursive: true });
      expect(await pool.attach(second)).toBe(true);
      await execute('pnpm', ['--dir', second, '--filter', '@acme/app', 'check'], { env: { ...process.env, CI: 'true' }, timeout: 20_000 });
      await pool.release(second);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('shares immutable dependencies, remaps workspace links, and keeps pnpm state local', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-deps-'));
    try {
      const first = await project(root, 'first');
      const second = await project(root, 'second');
      await mkdir(join(first, 'node_modules/lib'), { recursive: true });
      await mkdir(join(first, 'node_modules/@acme'), { recursive: true });
      await writeFile(join(first, 'node_modules/lib/index.js'), 'export default 1;');
      await writeFile(join(first, 'node_modules/.pnpm-workspace-state-v1.json'), 'mutable');
      await symlink('../../packages/app', join(first, 'node_modules/@acme/app'));
      const pool = new DependencyPool(join(root, 'pool'));
      expect(await pool.capture(first)).toBe(true);
      expect(await pool.attach(second)).toBe(true);
      expect((await lstat(join(second, 'node_modules'))).isSymbolicLink()).toBe(false);
      expect(await realpath(join(second, 'node_modules/lib'))).toBe(await realpath(join(first, 'node_modules/lib')));
      expect(await realpath(join(second, 'node_modules/@acme/app'))).toBe(await realpath(join(second, 'packages/app')));
      await expect(lstat(join(second, 'node_modules/.pnpm-workspace-state-v1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(join(second, 'node_modules/.pnpm-workspace-state-v1.json'), 'second');
      await expect(lstat(join(first, 'node_modules/.pnpm-workspace-state-v1.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      await pool.release(first);
      expect(await readFile(join(second, 'node_modules/lib/index.js'), 'utf8')).toBe('export default 1;');
      await pool.release(second);
      expect(await pool.attach(first)).toBe(true);
      await pool.release(first);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('invalidates on nested manifests and lockfiles and leaves existing installs alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-deps-key-'));
    try {
      const path = await project(root, 'project');
      const before = await dependencyKey(path);
      await writeFile(join(path, 'packages/app/package.json'), '{"name":"changed"}');
      expect(await dependencyKey(path)).not.toBe(before);
      const pool = new DependencyPool(join(root, 'pool'));
      await mkdir(join(path, 'node_modules/lib'), { recursive: true });
      await pool.capture(path);
      expect(await pool.attach(path)).toBe(false);
      await pool.release(path);
      await writeFile(join(path, 'pnpm-lock.yaml'), 'changed');
      expect(await pool.attach(path)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('evicts only unpinned pools when over budget and rejects external links', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-deps-lru-'));
    try {
      const path = await project(root, 'project');
      const other = await project(root, 'other');
      const pool = new DependencyPool(join(root, 'pool'), 0);
      await mkdir(join(path, 'node_modules/lib'), { recursive: true });
      await writeFile(join(path, 'node_modules/lib/index.js'), 'value');
      await pool.capture(path);
      await pool.attach(other);
      await pool.release(path);
      expect(await readFile(join(other, 'node_modules/lib/index.js'), 'utf8')).toBe('value');
      await pool.release(other);
      expect(await pool.attach(path)).toBe(false);
      await mkdir(join(path, 'node_modules'), { recursive: true });
      await symlink(root, join(path, 'node_modules/external'));
      expect(await pool.capture(path)).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
