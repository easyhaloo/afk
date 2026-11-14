import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(fileURLToPath(new URL('./analysis-process-guard.ts', import.meta.url)), 'utf8');
const match = source.match(/const analysisGuardSource = String\.raw`([\s\S]*?)`;/);
if (!match) throw new Error('Analysis guard source was not found');
const guard = match[1];

function fixture() {
  const pipe = Object.assign(new EventEmitter(), { destroy: vi.fn(), end: vi.fn() });
  const child = Object.assign(new EventEmitter(), {
    pid: 202, exitCode: null as number | null, signalCode: null as string | null,
    stdio: [undefined, undefined, undefined, pipe], kill: vi.fn(),
  });
  const parent = Object.assign(new EventEmitter(), {
    pid: 101, connected: true, argv: ['node', 'claude', '--help'], exit: vi.fn(),
  });
  const identity = vi.fn(() => '202 101 fixed-start-identity\n');
  const spawn = vi.fn(() => child);
  const timer = vi.fn(() => ({ unref: vi.fn() }));
  runInNewContext(guard, {
    process: parent, setTimeout: timer,
    require(name: string) {
      if (name !== 'node:child_process') throw new Error('Unexpected guard dependency');
      return { spawn, execFileSync: identity };
    },
  });
  return { pipe, child, parent, identity, spawn, timer };
}

describe('analysis start-gate failure ownership', () => {
  it('contains a closed start pipe and stops only its identified child', () => {
    const { pipe, child, parent, timer } = fixture();
    expect(pipe.end).toHaveBeenCalledWith('start\n');
    expect(() => pipe.emit('error', Object.assign(new Error('closed start pipe'), { code: 'EPIPE' }))).not.toThrow();
    expect(pipe.destroy).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(timer).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(parent.exit).not.toHaveBeenCalled();
    child.emit('exit', 1);
    expect(parent.exit).toHaveBeenCalledTimes(1);
    expect(parent.exit).toHaveBeenCalledWith(1);
  });

  it('never reports success when the child exits zero after start-gate failure', () => {
    const { pipe, child, parent } = fixture();
    try { pipe.emit('error', Object.assign(new Error('closed start pipe'), { code: 'EPIPE' })); } catch {}
    child.emit('exit', 0);
    expect(parent.exit).toHaveBeenCalledTimes(1);
    expect(parent.exit).toHaveBeenCalledWith(1);
  });

  it('does not signal a child whose identity changed before the pipe failure', () => {
    const { pipe, child, identity } = fixture();
    identity.mockReturnValue('202 101 replaced-start-identity\n');
    expect(() => pipe.emit('error', new Error('closed start pipe'))).not.toThrow();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each([7, 23])('preserves native failure %s after the start pipe closes', code => {
    const { pipe, child, parent } = fixture();
    pipe.emit('error', new Error('closed start pipe'));
    child.emit('exit', code);
    expect(parent.exit).toHaveBeenCalledTimes(1);
    expect(parent.exit).toHaveBeenCalledWith(code);
  });

  it('stops once across repeated pipe failures and parent disconnect', () => {
    const { pipe, child, parent, timer } = fixture();
    expect(() => {
      pipe.emit('error', new Error('closed start pipe'));
      parent.emit('disconnect');
      pipe.emit('error', new Error('already closed'));
    }).not.toThrow();
    expect(pipe.destroy).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(timer).toHaveBeenCalledTimes(1);
  });

  it.each([0, 7, null])('preserves ordinary child exit %s', code => {
    const { child, parent, pipe, spawn } = fixture();
    child.emit('exit', code);
    expect(parent.exit).toHaveBeenCalledTimes(1);
    expect(parent.exit).toHaveBeenCalledWith(code ?? 1);
    expect(child.kill).not.toHaveBeenCalled();
    expect(pipe.destroy).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('/usr/bin/sandbox-exec', [
      '-p', '(version 1)(allow default)(deny process-fork)', '/bin/sh', '-c',
      'IFS= read -r permit <&3 && [ "$permit" = start ] && exec "$@"', 'analysis', 'claude', '--help',
    ], { stdio: ['inherit', 'inherit', 'inherit', 'pipe'] });
  });
});
