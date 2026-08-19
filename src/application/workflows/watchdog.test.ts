import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ pid: 12345, unref: vi.fn() })),
}));

import { spawn } from 'child_process';
import { Watchdog } from './watchdog';

describe('Watchdog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('arm spawns a detached bash process whose script targets the session', () => {
    const wd = new Watchdog('/tmp/afk-logs-test');
    wd.arm('afk-gh-42', 60_000, 42, '/tmp/wt-42');

    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, opts] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(file).toBe('bash');
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('-c');
    expect(opts).toMatchObject({ detached: true, stdio: 'ignore' });

    const cmd = args[1] as string;
    // Timeout in seconds, session kill, log line.
    expect(cmd).toContain('sleep 60');
    expect(cmd).toContain('tmux kill-session -t "afk-gh-42"');
    expect(cmd).toContain('WATCHDOG:42:afk-gh-42:60000');
    expect(cmd).toContain('/tmp/afk-logs-test/watchdog.log');
  });

  it('disarm sends SIGTERM to the process group (negative pid)', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const wd = new Watchdog('/tmp/afk-logs-test');
    wd.arm('afk-gh-42', 60_000, 42, '/tmp/wt-42');

    wd.disarm();
    expect(killSpy).toHaveBeenCalledWith(-12345, 'SIGTERM');
    killSpy.mockRestore();
  });

  it('disarm is idempotent when nothing is armed', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    const wd = new Watchdog('/tmp/afk-logs-test');

    expect(() => wd.disarm()).not.toThrow();
    expect(killSpy).not.toHaveBeenCalled();

    // And a second disarm after arming + disarming is also a no-op.
    wd.arm('afk-gh-42', 60_000, 42, '/tmp/wt-42');
    wd.disarm();
    killSpy.mockClear();
    wd.disarm();
    expect(killSpy).not.toHaveBeenCalled();
    killSpy.mockRestore();
  });
});
