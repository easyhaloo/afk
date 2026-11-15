import { createHash } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerificationRequest, VerificationResult } from '../../plugin-sdk/capabilities.js';
import { CommandVerificationProvider } from './command.js';

type ExecutionRequest = VerificationRequest & { input?: string; executionId?: string };
type ObservedResult = VerificationResult & { execution?: {
  protocol: string; executionId: string; command: readonly string[]; cwd: string; inputDigest: string;
  exitCode: number; stdout: string; stderr: string; closed: boolean;
} };
const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
function directory() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'verification-proof-'));
  roots.push(root);
  return root;
}
function provider(script: string) {
  return new CommandVerificationProvider('test-runner', 'test-execution', [process.execPath, '-e', script], { timeoutMs: 1000 });
}

describe('command verification execution observations', () => {
  it('rejects a string command override before cloning or launching it', async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const selected = new CommandVerificationProvider('custom', 'test-execution', ['checker'], { runner });
    await expect(selected.verify({ target: directory(), command: 'checker' as unknown as readonly string[] })).rejects.toThrow('argv');
    expect(runner).not.toHaveBeenCalled();
  });

  it('keeps ordinary directory verification compatible without an execution request', async () => {
    const cwd = directory();
    const result = await provider('process.stdout.write(process.cwd())').verify({ target: cwd });
    expect(result).toEqual({ passed: true, durationMs: expect.any(Number), output: cwd });
  });

  it('sends semantic input through stdin while preserving the actual cwd and output streams', async () => {
    const cwd = directory();
    const input = JSON.stringify({ protocol: 'learning-validation-v1', binding: { candidateId: 'owned-candidate' } });
    const script = "let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',part=>data+=part);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({cwd:process.cwd(),input:JSON.parse(data)}));process.stderr.write('checker diagnostic')})";
    const selected = provider(script);
    const request: ExecutionRequest = { target: cwd, input, executionId: 'execution-1' };
    const result: ObservedResult = await selected.verify(request);
    expect(result.passed).toBe(true);
    expect(result.execution).toEqual({ protocol: 'verification-execution-v1', executionId: 'execution-1',
      command: [process.execPath, '-e', script], cwd, inputDigest: createHash('sha256').update(input).digest('hex'),
      exitCode: 0, stdout: JSON.stringify({ cwd, input: JSON.parse(input) }), stderr: 'checker diagnostic', closed: true });
    expect(result.output).toBe(`${result.execution!.stdout}\nchecker diagnostic`);
  });

  it('records the actual nonzero exit independently of a successful-looking report', async () => {
    const cwd = directory();
    const request: ExecutionRequest = { target: cwd, input: '{}', executionId: 'execution-failed' };
    const result: ObservedResult = await provider("process.stdout.write('{\"passed\":true}');process.stderr.write('denied');process.exitCode=17").verify(request);
    expect(result.passed).toBe(false);
    expect(result.execution).toMatchObject({ executionId: 'execution-failed', cwd, exitCode: 17,
      stdout: '{"passed":true}', stderr: 'denied', closed: true });
  });

  it('does not treat a receipt printed by the checker as the host observation', async () => {
    const cwd = directory();
    const forged = JSON.stringify({ protocol: 'verification-execution-v1', executionId: 'old-execution', cwd: '/forged', exitCode: 0 });
    const request: ExecutionRequest = { target: cwd, input: '{}', executionId: 'new-execution' };
    const result: ObservedResult = await provider(`process.stdout.write(${JSON.stringify(forged)})`).verify(request);
    expect(result.execution).toMatchObject({ executionId: 'new-execution', cwd, stdout: forged });
  });

  it('never fabricates an observation for a runner that only reports passed output', async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '{"passed":true}', stderr: '' }));
    const selected = new CommandVerificationProvider('custom', 'test-execution', ['checker'], { runner });
    const request: ExecutionRequest = { target: directory(), input: '{}', executionId: 'execution-custom' };
    const result: ObservedResult = await selected.verify(request);
    expect(result.passed).toBe(true);
    expect(result.execution).toBeUndefined();
    expect(runner).toHaveBeenCalledWith(['checker'], expect.objectContaining({ cwd: request.target, input: '{}', executionId: 'execution-custom' }));
  });

  it('does not endorse an observation supplied by an injected runner as native execution', async () => {
    const cwd = directory();
    const execution = { protocol: 'verification-execution-v1' as const, executionId: 'execution-injected',
      command: ['checker'], cwd, inputDigest: createHash('sha256').update('{}').digest('hex'),
      exitCode: 0, stdout: '{}', stderr: '', closed: true as const };
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '', execution }));
    const selected = new CommandVerificationProvider('custom', 'test-execution', ['checker'], { runner });
    const result: ObservedResult = await selected.verify({ target: cwd, input: '{}', executionId: 'execution-injected' } as ExecutionRequest);
    expect(result.execution).toBeUndefined();
  });

  it('rejects an expired caller deadline before launching a runner', async () => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '{}', stderr: '' }));
    const selected = new CommandVerificationProvider('custom', 'test-execution', ['checker'], { runner });
    await expect(selected.verify({ target: directory() }, { deadlineAt: Date.now() - 1 })).rejects.toThrow('deadline');
    expect(runner).not.toHaveBeenCalled();
  });

  it('rejects a runner success arriving after the absolute caller deadline', async () => {
    const runner = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 30)); return { exitCode: 0, stdout: '{}', stderr: '' }; });
    const selected = new CommandVerificationProvider('custom', 'test-execution', ['checker'], { runner });
    await expect(selected.verify({ target: directory() }, { deadlineAt: Date.now() + 10 })).rejects.toThrow('deadline');
  });

  it('cancels an owned native process without returning a successful observation', async () => {
    const stop = new AbortController();
    const request: ExecutionRequest = { target: directory(), input: '{}', executionId: 'execution-cancelled' };
    const pending = provider('setInterval(()=>{},1000)').verify(request, { signal: stop.signal });
    const timer = setTimeout(() => stop.abort(new Error('owned cancel')), 30);
    try { await expect(pending).rejects.toThrow('owned cancel'); }
    finally { clearTimeout(timer); }
  });

  it('binds the observation to the launched argv despite later caller mutation', async () => {
    const cwd = directory();
    const command = [process.execPath, '-e', "setTimeout(()=>process.stdout.write('original'),10)"];
    const original = [...command];
    const request: ExecutionRequest = { target: cwd, command, input: '', executionId: 'execution-pinned' };
    const pending = provider('process.exitCode=2').verify(request);
    command[2] = "process.stdout.write('changed')";
    const result: ObservedResult = await pending;
    expect(result.execution).toMatchObject({ command: original, stdout: 'original', inputDigest: createHash('sha256').update('').digest('hex') });
  });

  it('cannot qualify a process killed by the command timeout', async () => {
    const request: ExecutionRequest = { target: directory(), input: '{}', executionId: 'execution-timeout', timeoutMs: 30 };
    const result: ObservedResult = await provider('setInterval(()=>{},1000)').verify(request);
    expect(result.passed).toBe(false);
    expect(result.execution).toBeUndefined();
  });

  it.each([
    { input: 'x'.repeat(256 * 1024 + 1), executionId: 'execution-large' },
    { input: '😀'.repeat(65537), executionId: 'execution-utf8-large' },
    { input: '{}', executionId: 'bad\nidentity' },
    { input: '{}', executionId: '' },
  ])('rejects invalid observation input before launching ($executionId)', async addition => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    const selected = new CommandVerificationProvider('custom', 'test-execution', ['checker'], { runner });
    const request: ExecutionRequest = { target: directory(), ...addition };
    await expect(selected.verify(request)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
});
