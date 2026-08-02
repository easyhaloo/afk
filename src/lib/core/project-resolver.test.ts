import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { JumpProjectResolver } from './project-resolver';

/**
 * Mock spawn to return a controllable child process. The child emits stdout
 * and a close event on the next tick.
 */
function mockSpawnOnce(stdout: string, exitCode = 0) {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    child.stdout.emit('data', stdout);
    child.emit('close', exitCode);
  });
  return child;
}

describe('JumpProjectResolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('resolve', () => {
    it('uses `j <name>` via interactive zsh and returns the resolved path', async () => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() =>
        mockSpawnOnce('/home/user/work/easyhaloo/faker_agent\n'),
      );

      const path = await new JumpProjectResolver().resolve('easyhaloo/faker_agent');
      expect(path).toBe('/home/user/work/easyhaloo/faker_agent');

      const [cmd, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(cmd).toBe('zsh');
      expect(args).toEqual(['-i', '-c', expect.stringContaining('j easyhaloo/faker_agent')]);
    });

    it('falls back to the trailing segment when full-name lookup fails', async () => {
      // First call (full name) fails; second call (basename) succeeds.
      let call = 0;
      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        call++;
        return call === 1
          ? mockSpawnOnce('', 1) // j rejects
          : mockSpawnOnce('/home/user/work/faker_agent\n');
      });

      const path = await new JumpProjectResolver().resolve('easyhaloo/faker_agent');
      expect(path).toBe('/home/user/work/faker_agent');
      expect(spawn).toHaveBeenCalledTimes(2);
    });

    it('throws when no candidate resolves', async () => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => mockSpawnOnce('', 1));

      await expect(new JumpProjectResolver().resolve('does/not/exist'))
        .rejects.toThrow(/no local path/);
    });
  });

  describe('clone', () => {
    it('runs `gh repo clone` into ~/work/<sanitized> and returns that path', async () => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => mockSpawnOnce(''));

      const path = await new JumpProjectResolver().clone('easyhaloo/faker_agent');

      // gh clones INTO the target dir, not target/basename — git semantics.
      expect(path).toMatch(new RegExp(`/work/easyhaloo-faker_agent$`));
      const [cmd, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(cmd).toBe('gh');
      expect(args).toContain('repo');
      expect(args).toContain('clone');
      // / in the name must be sanitized to - in the dir name
      expect(args[2]).toBe('easyhaloo/faker_agent');
    });

    it('sanitizes slashes and leading dots so the clone dir stays inside ~/work/', async () => {
      (spawn as ReturnType<typeof vi.fn>).mockImplementation(() => mockSpawnOnce(''));
      await new JumpProjectResolver().clone('../../etc/passwd');
      const [, args] = (spawn as ReturnType<typeof vi.fn>).mock.calls[0];
      const target = args[3] as string;
      // Target must be inside HOME/work; sanitized basename must not start with a dot.
      expect(target).toMatch(new RegExp(`^${process.env.HOME}/work/`));
      const basename = target.split('/').pop()!;
      expect(basename.startsWith('.')).toBe(false);
      // Sanitized basename itself has no slashes (replaced with -).
      expect(basename).not.toMatch(/[\\/]/);
    });
  });
});