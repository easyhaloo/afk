import { describe, expect, it, vi } from 'vitest';
import { queryProviderInventory } from '../src/provider-inventory.js';

describe('provider inventory query', () => {
  it('filters rich provider records without losing project diagnostics', async () => {
    const port = { list: vi.fn(async () => ({
      items: [{ project: { platform: 'github' as const, projectKey: 'acme/api' }, state: 'ready', executionMode: 'afk', tags: ['urgent'], title: 'Keep' }],
      projects: [{ platform: 'github' as const, projectKey: 'acme/api' }],
      diagnostics: [{ platform: 'github' as const, projectKey: 'github.com', code: 'project_list_failed', message: 'rate limit' }],
      complete: false,
    })) };
    const result = await queryProviderInventory({ platform: 'github', project: 'acme/api', state: 'ready', executionMode: 'afk', tag: 'urgent' }, port);
    expect(port.list).toHaveBeenCalledWith('github');
    expect(result.items[0].title).toBe('Keep');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.complete).toBe(false);
  });
});
