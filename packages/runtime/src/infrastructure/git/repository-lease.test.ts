import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { RepositoryLeases, repositoryClaimIds, recoverRepositoryLease } from './repository-lease.js';
describe('RepositoryLeases', () => {
  it('recovers only registered sessions with the expired generation ownership token', async () => {
    const claim = { claimId: 'generation-1', owner: JSON.stringify({ recovery: 'registered-tmux' }),
      createdAt: '', heartbeatAt: '', expiresAt: '', ttlMs: 1000 };
    const resource = { kind: 'tmux', name: 'owned-session', metadata: { repositoryClaims: [claim.claimId], tmuxPaneId: '%19', tmuxWindowName: 'main' } };
    const registry = { listAllActive: vi.fn(() => [resource]), markClosed: vi.fn() };
    const tmux = { sessionStatus: vi.fn().mockResolvedValueOnce('present').mockResolvedValue('missing'),
      firstPaneId: vi.fn(async () => '%19'), sessionOwnership: vi.fn(async () => 'generation-1'), killSession: vi.fn() };
    expect(await recoverRepositoryLease(claim, { registry: registry as never, tmux, dead: () => true })).toBe(true);
    expect(tmux.killSession).toHaveBeenCalledWith('owned-session');
    expect(registry.markClosed).toHaveBeenCalledOnce();
    registry.markClosed.mockClear();
    tmux.killSession.mockClear();
    tmux.sessionStatus.mockResolvedValue('present');
    tmux.sessionOwnership.mockResolvedValue('generation-2');
    expect(await recoverRepositoryLease(claim, { registry: registry as never, tmux, dead: () => true })).toBe(false);
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(registry.markClosed).not.toHaveBeenCalled();
    expect(await recoverRepositoryLease({ ...claim, owner: '{"recovery":"manual"}' }, { registry: registry as never, tmux, dead: () => true })).toBe(false);
    expect(await recoverRepositoryLease(claim, { registry: registry as never, tmux, dead: () => false })).toBe(false);
  });

  it('binds nested phases to the same repository generations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-repo-lease-scope-'));
    try {
      const manager = new RepositoryLeases(root);
      expect(repositoryClaimIds()).toEqual([]);
      await manager.run(['github:acme/api'], async () => {
        const ids = repositoryClaimIds();
        expect(ids).toHaveLength(1);
        const borrowed = await manager.acquire(['github:acme/api']);
        expect(borrowed.claimIds).toEqual(ids);
        await borrowed.release();
        expect(await manager.active(['github:acme/api'])).toBe(true);
      });
      expect(await manager.active(['github:acme/api'])).toBe(false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('serializes overlapping repositories and releases partial acquisitions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'afk-repo-leases-'));
    try {
      const manager = new RepositoryLeases(root);
      const first = await manager.acquire(['github:acme/api']);
      const independent = await manager.acquire(['github:acme/web']);
      await expect(manager.acquire(['github:acme/aaa', 'github:acme/api'])).rejects.toThrow('leased');
      const partial = await manager.acquire(['github:acme/aaa']);
      await first.heartbeat();
      await first.release();
      await expect(first.heartbeat()).rejects.toThrow('released');
      const next = await manager.acquire(['github:acme/api']);
      await Promise.all([partial.release(), independent.release(), next.release()]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
