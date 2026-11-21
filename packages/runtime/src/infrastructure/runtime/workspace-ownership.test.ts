import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesystemClaimLock, type ExpiredClaim } from '../../domain/backlog/claim.js';
import { assertWorkspaceOwnershipAvailable, executionOwnershipKeys, withWorkspaceOwnershipAvailable } from './workspace-ownership.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('workspace ownership availability', () => {
  it('canonicalizes workspace aliases and GitHub repository case and returns sorted unique keys', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'workspace-ownership-')));
    roots.push(root);
    const alias = join(root, 'alias');
    symlinkSync(root, alias);
    const expected = await executionOwnershipKeys(root, [{ platform: 'github', projectKey: 'acme/api' }]);
    expect(await executionOwnershipKeys(alias, [{ platform: 'github', projectKey: 'Acme/API' },
      { platform: 'github', projectKey: 'acme/api' }])).toEqual(expected);
    expect(expected).toHaveLength(2);
    expect(expected).toEqual([...expected].sort());
    expect(await executionOwnershipKeys(root, [{ platform: 'gitlab', projectKey: 'Acme/API' }]))
      .not.toEqual(await executionOwnershipKeys(root, [{ platform: 'gitlab', projectKey: 'acme/api' }]));
  });

  it('holds all ownership gates through the operation and unwinds them after failure', async () => {
    const active = new Set<string>();
    const order: string[] = [];
    vi.spyOn(FilesystemClaimLock.prototype, 'inspect').mockResolvedValue(null);
    vi.spyOn(FilesystemClaimLock.prototype, 'withExclusiveOperation').mockImplementation(async (key, operation) => {
      active.add(key); order.push(key);
      try { return await operation(); } finally { active.delete(key); }
    });
    await expect(withWorkspaceOwnershipAvailable('/isolated/workspace', [{ platform: 'github', projectKey: 'acme/api' }], async () => {
      expect(active.size).toBe(2);
      throw new Error('operation failed');
    })).rejects.toThrow('operation failed');
    expect(order).toEqual([...order].sort());
    expect(active.size).toBe(0);
  });

  it('rejects retained ownership and inspection errors without entering the operation', async () => {
    const held: ExpiredClaim = { claimId: 'held-claim', owner: 'fixture', createdAt: '2026-11-16T00:00:00Z',
      heartbeatAt: '2026-11-16T00:00:00Z', expiresAt: '2026-11-16T01:00:00Z', ttlMs: 3600000 };
    const inspect = vi.spyOn(FilesystemClaimLock.prototype, 'inspect').mockResolvedValue(held);
    vi.spyOn(FilesystemClaimLock.prototype, 'withExclusiveOperation').mockImplementation(async (_key, operation) => operation());
    const operation = vi.fn(async () => undefined);
    await expect(withWorkspaceOwnershipAvailable('/isolated/workspace', [], operation)).rejects.toThrow('quarantined');
    await expect(assertWorkspaceOwnershipAvailable('/isolated/workspace', [], ['held-claim'])).resolves.toBeUndefined();
    await expect(assertWorkspaceOwnershipAvailable('/isolated/workspace', [])).rejects.toThrow('quarantined');
    inspect.mockRejectedValue(new Error('ownership unavailable'));
    await expect(withWorkspaceOwnershipAvailable('/isolated/workspace', [], operation)).rejects.toThrow('ownership unavailable');
    expect(operation).not.toHaveBeenCalled();
  });
});
