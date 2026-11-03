import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readSignalSync } from '../io/signal.js';
import { TmuxClient, normalizeTmuxSessionName } from './tmux.js';
import { ControlModeConnection } from './control-mode.js';

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

describe('TmuxClient provider readiness', () => {
  it('accepts non-Claude interactive providers after their tmux session exists', async () => {
    const client = new TmuxClient();
    vi.spyOn(client as any, 'hasSession').mockResolvedValue(true);
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
    vi.spyOn(client, 'capturePane').mockResolvedValue('› Ask Codex to do anything');

    await expect(client.waitForPrompt('/missing-status', 10, 'codex', 'codex-session')).resolves.toBe(true);
  });

  it('reports a missing session for an interactive provider', async () => {
    const client = new TmuxClient();
    vi.spyOn(client as any, 'hasSession').mockResolvedValue(false);
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);

    await expect(client.waitForPrompt('/missing-status', 10, 'codex', 'codex-session')).resolves.toBe(false);
  });

  it('waits for the Codex composer before treating the session as ready', async () => {
    const client = new TmuxClient();
    vi.spyOn(client as any, 'hasSession').mockResolvedValue(true);
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
    const capture = vi.spyOn(client, 'capturePane')
      .mockResolvedValueOnce('› the goal is still typed into the composer')
      .mockResolvedValue('› Ask Codex to do anything');

    await expect(client.waitForPrompt('/w', 1000, 'codex', 'codex-session')).resolves.toBe(true);
    expect(capture).toHaveBeenCalled();
  });
});

describe('TmuxClient prompt submission', () => {
  const countEnterPresses = (exec: { mock: { calls: unknown[][] } }): number =>
    exec.mock.calls.filter(call => Array.isArray(call[0]) && (call[0] as string[]).includes('C-m')).length;

  it('presses Enter again while the Codex composer still holds the goal', async () => {
    const client = new TmuxClient();
    const exec = vi.spyOn(client as any, 'exec').mockResolvedValue('');
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'waitForPrompt').mockResolvedValue(true);
    const capture = vi.spyOn(client, 'capturePane')
      .mockResolvedValueOnce('› the goal is still typed into the composer')
      .mockResolvedValue('› Ask Codex to do anything');

    await client.sendPrompt('/w', 'sess', 'main', 'do the work', 'goal_complete', 'codex');

    // Two Enter presses submit the goal; a third one is spent on the goal
    // that a modal swallowed.
    expect(countEnterPresses(exec as never)).toBe(3);
    expect(capture).toHaveBeenCalled();
  });

  it('does not press Enter again once the composer is empty', async () => {
    const client = new TmuxClient();
    const exec = vi.spyOn(client as any, 'exec').mockResolvedValue('');
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'waitForPrompt').mockResolvedValue(true);
    vi.spyOn(client, 'capturePane').mockResolvedValue('› Ask Codex to do anything');

    await client.sendPrompt('/w', 'sess', 'main', 'do the work', 'goal_complete', 'codex');

    expect(countEnterPresses(exec as never)).toBe(2);
  });

  it('leaves providers without a readable composer untouched', async () => {
    const client = new TmuxClient();
    const exec = vi.spyOn(client as any, 'exec').mockResolvedValue('');
    vi.spyOn(client as any, 'sleep').mockResolvedValue(undefined);
    vi.spyOn(client as any, 'waitForPrompt').mockResolvedValue(true);
    const capture = vi.spyOn(client, 'capturePane').mockResolvedValue('› the goal is still typed');

    await client.sendPrompt('/w', 'sess', 'main', 'do the work', 'goal_complete', 'claude-code');

    expect(countEnterPresses(exec as never)).toBe(2);
    expect(capture).not.toHaveBeenCalled();
  });
});

describe('ControlModeConnection pipe failures', () => {
  const hasTmux = (() => {
    try { execFileSync('tmux', ['-V'], { stdio: 'pipe' }); return true; } catch { return false; }
  })();

  it.skipIf(!hasTmux)('does not write to a control pipe that closed with the session', async () => {
    const session = `afk-test-epipe-${Date.now()}`;
    const client = new TmuxClient();
    await client.createSession(session, tmpdir(), 'sleep 30');
    const connection = new ControlModeConnection({ session });
    const exited = new Promise<void>(resolve => connection.onExit(() => resolve()));
    try {
      // Killing the session makes tmux exit, which closes the control pipe.
      await client.killSession(session);
      await exited;
      const writes: string[] = [];
      (connection as any).stdin.write = (chunk: string) => { writes.push(String(chunk)); return true; };
      connection.sendRawCommand('noop');
      // A write to a dead pipe is what produced the unhandled EPIPE that
      // failed the whole test run.
      expect(writes).toEqual([]);
    } finally {
      connection.close();
      await client.killSession(session).catch(() => undefined);
    }
  }, 30000);

  it('absorbs a control pipe error instead of crashing the process', () => {
    const connection = new ControlModeConnection({ session: 'afk-test-no-such-session' });
    try {
      // Without an error listener the socket turns this into an uncaught
      // exception, which fails the run over a write nobody waits for.
      expect(() => (connection as any).stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
      expect((connection as any).exited).toBe(true);
    } finally {
      connection.close();
    }
  });
});
