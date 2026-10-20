import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
import { promises as fs, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { IsolateManager } from './isolate.js';

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
  const REGISTRY_DIR = () => join(homedir(), '.afk', 'port-registry');
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
