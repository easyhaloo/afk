import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readSignalSync } from '../io/signal.js';
import { TmuxClient, normalizeTmuxSessionName } from './tmux.js';

describe('normalizeTmuxSessionName', () => {
  it('rewrites colons the same way tmux stores session names', () => {
    expect(normalizeTmuxSessionName('github:easyhaloo/afk#144')).toBe('github_easyhaloo/afk#144');
    expect(normalizeTmuxSessionName('afk-144-implement')).toBe('afk-144-implement');
  });
});

describe('TmuxClient with special-character session names', () => {
  const hasTmux = (() => {
    try { execFileSync('tmux', ['-V'], { stdio: 'pipe' }); return true; } catch { return false; }
  })();

  it.skipIf(!hasTmux)('round-trips a backlog-id session name through create/lookup/kill', async () => {
    const client = new TmuxClient();
    const raw = `afk-test-github:proj#144-${Date.now()}`;
    const normalized = normalizeTmuxSessionName(raw);
    try {
      const session = await client.createSession(raw, tmpdir(), 'sleep 30');
      expect(session.name).toBe(normalized);
      // Raw and normalized names must both resolve to the same session.
      await expect(client.hasSession(raw)).resolves.toBe(true);
      await expect(client.capturePane(raw, 'main', { lines: 1 })).resolves.not.toBe('(capture failed)');
      await client.sendKeys(normalized, 'main', 'q');
      await expect(client.killSession(raw)).resolves.toBeUndefined();
      await expect(client.hasSession(raw)).resolves.toBe(false);
    } finally {
      await client.killSession(raw).catch(() => undefined);
    }
  }, 30000);
});

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
