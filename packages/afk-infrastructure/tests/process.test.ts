import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { probeProcess } from '../src/io/process.js';

function exitedProcess(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    child.on('exit', () => resolve(child.pid ?? 0));
    child.on('error', reject);
  });
}

describe('probeProcess', () => {
  it('says a live process is alive', () => {
    expect(probeProcess(process.pid)).toBe(true);
  });

  it('says a process that has exited is gone', async () => {
    const pid = await exitedProcess();
    // The pid is free now; a probe may still find it if the system has
    // not recycled it, so the answer has to be "not alive" either way.
    expect(probeProcess(pid)).not.toBe(true);
  });

  it('says a pid that cannot name a process is gone', () => {
    expect(probeProcess(0)).toBe(false);
    expect(probeProcess(-1)).toBe(false);
    expect(probeProcess(1.5)).toBe(false);
    expect(probeProcess(Number.NaN)).toBe(false);
  });
});
