import { describe, expect, it, vi } from 'vitest';
import { SystemActionExecutor } from './system-actions';

describe('SystemActionExecutor', () => {
  it('runs only declared system actions', async () => {
    const publish = vi.fn(async () => ({ url: 'https://mr/1' }));
    const executor = new SystemActionExecutor({ publishChange: publish, queueQA: async () => ({ queued: true }) });
    await expect(executor.execute('publish-change', { iid: 1 })).resolves.toEqual({ url: 'https://mr/1' });
    expect(publish).toHaveBeenCalledWith({ iid: 1 });
    await expect(executor.execute('shell', {})).rejects.toThrow(/unknown system action/);
  });
});
