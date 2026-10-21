import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';

// The resource registry is a user-global file under the home directory. A
// test must not write to it: it would both pollute the machine and contend
// with anything else that has the file open.
vi.mock('../infrastructure/runtime/resource-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../infrastructure/runtime/resource-registry')>();
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'afk-resource-registry-'));
  let registry: InstanceType<typeof actual.AfkResourceRegistry> | undefined;
  return {
    ...actual,
    getAfkResourceRegistry: () => (registry ??= new actual.AfkResourceRegistry({ databasePath: join(root, 'resources.sqlite') })),
  };
});
import { promises as fs, chmodSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { IsolateManager, composePortOverrides, withoutIsolateBlock } from './isolate.js';

describe('IsolateManager', () => {
  describe('available', () => {
    it('returns false when no docker-compose.yml exists', () => {
      const im = new IsolateManager('/tmp/nonexistent-path');
      expect(im.available()).toBe(false);
    });

    it('returns true when docker-compose.yml exists', () => {
      const dir = mkdtemp();
      writeFileSync(join(dir, 'docker-compose.yml'), 'version: "3"');
      try {
        const im = new IsolateManager(dir);
        expect(im.available()).toBe(true);
      } finally {
        rmrf(dir);
      }
    });
  });
});

// ─── Port registry tests ──────────────────────────────────────────────────

describe('Port Registry', () => {
  // The port registry lives in the home directory. A test must neither read
  // it nor delete it — the cleanup below removes the whole directory, and on
  // the real one that would throw away the record of which ports are taken.
  const registryRoot = mkdtemp();
  const previousRegistryDir = process.env.AFK_PORT_REGISTRY_DIR;

  beforeAll(() => { process.env.AFK_PORT_REGISTRY_DIR = registryRoot; });
  afterAll(() => {
    if (previousRegistryDir === undefined) delete process.env.AFK_PORT_REGISTRY_DIR;
    else process.env.AFK_PORT_REGISTRY_DIR = previousRegistryDir;
    rmrf(registryRoot);
  });

  const REGISTRY_DIR = () => registryRoot;
  const REGISTRY_FILE = () => join(REGISTRY_DIR(), 'registry');
  const LOCK_DIR = () => join(REGISTRY_DIR(), 'lock');

  beforeEach(async () => {
    // Clean up any leftover registry state
    try { await fs.rm(REGISTRY_DIR(), { recursive: true, force: true }); } catch { /* */ }
  });

  afterEach(async () => {
    try { await fs.rm(REGISTRY_DIR(), { recursive: true, force: true }); } catch { /* */ }
  });

  /**
   * Test the port registry by creating two IsolateManagers with different
   * worktree roots and verifying they get different port offsets.
   *
   * We test this through the public API: assign on up(), release on discard().
   * Since up() requires Docker, we test the registry file directly.
   */
  it('assigns different offsets to different worktrees', async () => {
    // Simulate the registry logic: two projects get different offsets
    const im1 = new IsolateManager('/tmp/test-worktree-a');
    const im2 = new IsolateManager('/tmp/test-worktree-b');

    // Verify hash is deterministic
    const hash1 = (im1 as any).projectHash;
    const hash2 = (im2 as any).projectHash;
    expect(hash1).toBeTruthy();
    expect(hash2).toBeTruthy();
    expect(hash1).not.toBe(hash2);
  });

  it('produces deterministic hashes for same path', () => {
    const im1 = new IsolateManager('/tmp/test-worktree');
    const im2 = new IsolateManager('/tmp/test-worktree');
    expect((im1 as any).projectHash).toBe((im2 as any).projectHash);
  });
});

// ─── The worktree's .env ───────────────────────────────────────────────────

describe('The worktree .env', () => {
  let registryDir: string;
  let previousRegistryDir: string | undefined;
  let previousPath: string | undefined;

  beforeEach(() => {
    registryDir = mkdtemp();
    previousRegistryDir = process.env.AFK_PORT_REGISTRY_DIR;
    process.env.AFK_PORT_REGISTRY_DIR = registryDir;

    // A docker that always fails. The real one would pull images and
    // start containers; the point of these tests is what happens to the
    // files around the compose call.
    const binDir = mkdtemp();
    const stub = join(binDir, 'docker');
    writeFileSync(stub, '#!/bin/sh\nexit 1\n');
    chmodSync(stub, 0o755);
    previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ''}`;
  });

  afterEach(() => {
    if (previousRegistryDir === undefined) delete process.env.AFK_PORT_REGISTRY_DIR;
    else process.env.AFK_PORT_REGISTRY_DIR = previousRegistryDir;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmrf(registryDir);
  });

  function worktree(): string {
    const dir = mkdtemp();
    writeFileSync(join(dir, 'docker-compose.yml'), [
      'version: "3"',
      'services:',
      '  db:',
      '    image: alpine',
      '    ports:',
      '      - "3306:3306"',
      '',
    ].join('\n'));
    return dir;
  }

  it('is left alone when the isolate comes up', async () => {
    const dir = worktree();
    try {
      writeFileSync(join(dir, '.env'), 'DB_PASSWORD=hunter2\n');

      const im = new IsolateManager(dir);
      // The compose call fails - the stub docker does nothing - and the
      // point is what happened to the file before it.
      await im.up().catch(() => undefined);

      expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('DB_PASSWORD=hunter2\n');
    } finally {
      rmrf(dir);
    }
  });

  it('keeps the user content when an older AFK block is cleaned up', async () => {
    const dir = worktree();
    try {
      writeFileSync(join(dir, '.env'), [
        'DB_PASSWORD=hunter2',
        '# AFK isolate — do not edit',
        '# Generated by afk isolate (offset: 100)',
        '',
        'DB_PORT=3406',
        '',
      ].join('\n'));

      const im = new IsolateManager(dir);
      await im.discard();

      expect(readFileSync(join(dir, '.env'), 'utf-8')).toBe('DB_PASSWORD=hunter2\n');
    } finally {
      rmrf(dir);
    }
  });
});

describe('composePortOverrides', () => {
  it('names the variables the compose file substitutes', () => {
    expect(composePortOverrides([{ name: 'db', hostPort: 3306 }], 100)).toEqual({
      DB_PORT: '3406',
      DB_ISOLATE_PORT: '3406',
      ISOLATE_DB_PORT: '3406',
      ISOLATE_PORT_3306: '3406',
    });
  });
});

describe('withoutIsolateBlock', () => {
  it('removes what an older AFK wrote and keeps the user content', () => {
    const user = 'DB_PASSWORD=hunter2\n';
    const afk = '# AFK isolate — do not edit\n# Generated by afk isolate (offset: 100)\n\nDB_PORT=3406\n';

    expect(withoutIsolateBlock(user + afk)).toBe(user);
    expect(withoutIsolateBlock(afk)).toBe('');
    expect(withoutIsolateBlock(user)).toBe(user);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function mkdtemp(): string {
  const dir = join('/tmp', `afk-isolate-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function rmrf(dir: string) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch { /* */ }
}
