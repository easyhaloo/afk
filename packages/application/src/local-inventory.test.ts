import { describe, expect, it, vi } from 'vitest';
import { refreshLocalInventory, type LocalInventoryStore, type InventorySnapshot } from './local-inventory.js';

describe('persistent inventory refresh', () => {
  it('starts before networking and publishes a partial result unchanged', async () => {
    const scope = { platform: 'github' as const, host: 'github.com', kind: 'catalog' as const };
    const attempt = { scope, sequence: 3 };
    const snapshot: InventorySnapshot = { items: [], projects: [], diagnostics: [], complete: false };
    const events: string[] = [];
    const store = {
      begin: vi.fn(async () => { events.push('begin'); return attempt; }),
      publish: vi.fn(async () => { events.push('publish'); return true; }),
      fail: vi.fn(),
    } as unknown as LocalInventoryStore;
    const result = await refreshLocalInventory(scope, { store, load: async () => { events.push('network'); return snapshot; } });
    expect(result).toBe(snapshot);
    expect(events).toEqual(['begin', 'network', 'publish']);
    expect(store.publish).toHaveBeenCalledWith(attempt, snapshot);
  });

  it('records a failed attempt and retains the original error', async () => {
    const scope = { platform: 'gitlab' as const, host: 'gitlab.invalid', kind: 'issues' as const, projectKey: 'gitlab.invalid/team/api' };
    const attempt = { scope, sequence: 1 };
    const store = { begin: vi.fn(async () => attempt), publish: vi.fn(), fail: vi.fn(async () => true) } as unknown as LocalInventoryStore;
    const error = new Error('unreachable');
    await expect(refreshLocalInventory(scope, { store, load: async () => { throw error; } })).rejects.toBe(error);
    expect(store.publish).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(attempt, expect.objectContaining({ code: 'inventory_refresh_failed', message: 'unreachable' }));
  });
});
