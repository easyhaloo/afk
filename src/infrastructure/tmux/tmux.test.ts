import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readSignalSync } from '../io/signal';
import { TmuxClient } from './tmux';

describe('TmuxClient signal readers', () => {
  it('uses the infrastructure schema by default', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afk-tmux-signal-'));
    try {
      const signal = {
        type: 'goal_complete',
        timestamp: new Date().toISOString(),
        summary: 'verified',
        kind: 'ac_verification',
      };
      await writeFile(join(dir, '.afk-signal.json'), JSON.stringify(signal));

      await expect(new TmuxClient().waitForSignal('', '', 'goal_complete', dir, 100)).resolves.toEqual(signal);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses injected signal readers for legacy validation', async () => {
    const signal = { type: 'goal_complete' as const, timestamp: new Date().toISOString(), summary: 'legacy' };
    const readLegacySignal = vi.fn(async () => signal);
    const client = new TmuxClient({ readSignal: readLegacySignal, readSignalSync });

    await expect(client.waitForSignal('', '', 'goal_complete', '/unused', 100)).resolves.toEqual(signal);
    expect(readLegacySignal).toHaveBeenCalledWith('/unused');
  });
});
