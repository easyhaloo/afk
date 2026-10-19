import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

/**
 * Verifies that a spawned child which reads stdin completes when stdin reaches EOF.
 *
 * Bug: execFile gives the child a stdin pipe that is never written to and never
 * closed. A CLI like codex that reads stdin blocks forever at "Reading additional
 * input from stdin...".
 *
 * Fix: use spawn with stdio: ['ignore', 'pipe', 'pipe'] so stdin is /dev/null.
 *
 * This test uses a Python one-liner that exits 0 when it reads EOF (no input).
 * With a connected stdin pipe (execFile default): hangs.
 * With stdin: ignore (spawn fix): exits 0 immediately.
 */
describe('runCodexDoctor stdin handling', () => {
  it('child that reads stdin completes when stdin is ignored', async () => {
    // python3 -c "import sys; sys.stdin.read(); exit(0)" reads stdin then exits 0.
    // With stdin connected (pipe): hangs forever. With stdin: ignore: exits immediately.
    const child = spawn('python3', ['-c', 'import sys; sys.stdin.read(); exit(0)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    });

    let exited = false;
    child.on('exit', () => { exited = true; });

    // Poll for up to 2s — the child should exit near-instantly with stdin: ignore.
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 100));
      if (exited) break;
    }

    child.kill();
    expect(exited).toBe(true);
  });
});
