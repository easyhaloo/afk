import { describe, expect, it, vi } from 'vitest';
import { openBacklogUrl } from './handlers';

describe('openBacklogUrl', () => {
  it('opens only the URL supplied by the backlog provider', async () => {
    const open = vi.fn(async (_url: string) => {});

    await expect(openBacklogUrl({ id: '42', webUrl: 'https://example.test/42' }, open)).resolves.toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('https://example.test/42');
  });

  it('does not invoke the opener when a backlog has no provider URL', async () => {
    const open = vi.fn(async (_url: string) => {});

    await expect(openBacklogUrl({ id: '42' }, open)).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
