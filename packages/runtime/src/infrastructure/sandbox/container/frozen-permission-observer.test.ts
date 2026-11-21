import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startFrozenPermissionWitness } from './frozen-permission-observer.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

const request = {
  observerImageId: `sha256:${'a'.repeat(64)}`,
  operationId: '12345678-1234-4321-8765-1234567890ab',
  containerId: 'b'.repeat(64),
  target: '/workspace/asset.js',
  timeoutMs: 5_000,
};
const observerId = 'c'.repeat(64);
const receipt = 'W06_READY\n\n@scope: 9007199254740993\n@started: 1\n@observations: 1\n\n@finished: 1\n';
const dockerMock = vi.mocked(execFile);

afterEach(async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  dockerMock.mockReset().mockImplementation(actual.execFile);
});

function mockDocker({ removeFails = false, setupStatus = 'created' }: { removeFails?: boolean; setupStatus?: string } = {}) {
  const stdout = new PassThrough();
  const calls: string[][] = [];
  type Callback = (error: Error | null, stdout: string, stderr: string) => void;
  let done: Callback | undefined;
  dockerMock.mockImplementation(((_binary: string, args: string[], options: { signal?: AbortSignal }, callback: Callback) => {
    calls.push(args);
    queueMicrotask(() => {
      if (args[0] === 'info') callback(null, 'linux 2 cgroupfs 6.10.14-linuxkit\n', '');
      else if (args[1] === 'inspect') callback(null, `${request.containerId}|${setupStatus}||no|true|${request.operationId}\n`, '');
      else if (args[1] === 'create') callback(null, `${observerId}\n`, '');
      else if (args[1] === 'start') {
        done = callback;
        options.signal?.addEventListener('abort', () => callback(new Error('aborted'), '', ''), { once: true });
      } else if (args[1] === 'rm') callback(removeFails ? new Error('remove failed') : null, '', '');
      else if (args[1] === 'ls') callback(null, removeFails ? `${observerId}\n` : '', '');
      else callback(new Error('unexpected Docker invocation'), '', '');
    });
    return { stdout };
  }) as unknown as typeof execFile);
  return {
    calls, stdout,
    async attached() { await vi.waitFor(() => expect(done).toBeDefined()); },
    complete(output: string, diagnostic = '', error: Error | null = null) { done!(error, output, diagnostic); },
  };
}

describe('frozen permission witness', () => {
  it('waits for a complete readiness marker and accepts an observed zero', async () => {
    const docker = mockDocker();
    const start = startFrozenPermissionWitness(request);
    await docker.attached();
    docker.stdout.write('W06_RE');
    expect(docker.calls.filter(args => args[1] === 'inspect')).toHaveLength(1);
    docker.stdout.write('ADY\n');
    const witness = await start;
    expect(docker.calls.filter(args => args[1] === 'inspect')).toHaveLength(2);
    const create = docker.calls.find(args => args[1] === 'create')!;
    expect(create).toEqual(expect.arrayContaining(['--pull=never', '--network=none', '--cap-drop=ALL', '--cap-add=BPF', '--cap-add=PERFMON']));
    expect(create.flatMap((arg, index) => arg === '--label' ? [create[index + 1]] : [])).toEqual([
      `afk.frozen.operation=${request.operationId}`, 'afk.frozen.managed=true',
    ]);
    expect(create).not.toContain('--privileged');
    expect(create.slice(-2)).toEqual([`/docker/${request.containerId}`, request.target]);
    docker.complete(receipt);
    await expect(witness.finish()).resolves.toEqual({ cgroupId: '9007199254740993', deniedWrites: 0 });
    await witness.close();
    expect(docker.calls.slice(-2)).toEqual([
      ['container', 'rm', '--force', '--volumes', observerId], ['container', 'ls', '--all', '--quiet', '--filter', `id=${observerId}`],
    ]);
  });

  it.each([
    ['missing completion', receipt.replace('@finished: 1\n', ''), '', null],
    ['missing count', receipt.replace('@observations: 1\n', ''), '', null],
    ['partial last line', receipt.slice(0, -1), '', null],
    ['duplicate start', receipt.replace('@started: 1', '@started: 2'), '', null],
    ['duplicate field', `${receipt}@scope: 42\n`, '', null],
    ['trace warning', receipt, 'lost events', null],
    ['output overflow', receipt, '', new Error('stdout maxBuffer length exceeded')],
  ])('rejects %s and removes the observer', async (_case, output, stderr, error) => {
    const docker = mockDocker();
    const start = startFrozenPermissionWitness(request);
    await docker.attached();
    docker.stdout.write('W06_READY\n');
    const witness = await start;
    docker.complete(output, stderr, error);
    await expect(witness.finish()).rejects.toThrow(/permission witness/i);
    await expect(witness.close()).resolves.toBeUndefined();
    expect(docker.calls.filter(args => args[1] === 'rm')).toHaveLength(1);
  });

  it('rejects a stopped trace before readiness and confirms cleanup', async () => {
    const docker = mockDocker();
    const start = startFrozenPermissionWitness(request);
    const rejected = expect(start).rejects.toThrow(/trace failed/);
    await docker.attached();
    docker.complete('', 'attach failure', new Error('exit 1'));
    await rejected;
    expect(docker.calls.at(-1)?.[1]).toBe('ls');
  });

  it('reports unconfirmed cleanup on cancellation after readiness', async () => {
    const docker = mockDocker({ removeFails: true });
    const controller = new AbortController();
    const start = startFrozenPermissionWitness({ ...request, signal: controller.signal });
    await docker.attached();
    docker.stdout.write('W06_READY\n');
    const witness = await start;
    controller.abort(new Error('cancelled'));
    await expect(witness.finish()).rejects.toThrow(/cleanup was not confirmed/);
    await expect(witness.close()).rejects.toThrow(/cleanup could not be confirmed/);
  });

  it('times out at the collection deadline and confirms cleanup', async () => {
    const docker = mockDocker();
    const start = startFrozenPermissionWitness({ ...request, timeoutMs: 100 });
    await docker.attached();
    docker.stdout.write('W06_READY\n');
    const witness = await start;
    await expect(witness.finish()).rejects.toThrow(/timed out/);
    expect(docker.calls.at(-1)?.[1]).toBe('ls');
  });

  it('rejects a noncanonical, overlength, or already-started target before allocating', async () => {
    const docker = mockDocker({ setupStatus: 'running' });
    for (const target of ['/workspace/../outside', `/workspace/${'a'.repeat(246)}`, '/workspace/a;echo']) {
      await expect(startFrozenPermissionWitness({ ...request, target })).rejects.toThrow('Invalid frozen permission witness request');
    }
    expect(docker.calls).toHaveLength(0);
    await expect(startFrozenPermissionWitness(request)).rejects.toThrow(/unstarted/);
    expect(docker.calls.map(args => args.slice(0, 2))).toEqual([['info', '--format'], ['container', 'inspect']]);
  });
});

const nativeObserverImageId = process.env.W06_PERMISSION_OBSERVER_IMAGE;
describe.runIf(Boolean(nativeObserverImageId))('Linux Docker permission witness', () => {
  const docker = (...args: string[]) => execFileSync('docker', args,
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8_000 }).trim();
  const fixture = fileURLToPath(import.meta.url);
  const target = `/workspace/${'a'.repeat(245)}`;
  const otherPath = `${target}b`;
  const denied = (path: string) => `try { require('node:fs').openSync(${JSON.stringify(path)}, 'r+'); throw Error('opened'); } catch (error) { if (error.code !== 'EROFS') throw error; }`;
  const worker = (operationId: string, source: string) => docker('container', 'create', '--pull=never', '--read-only',
    '--network=none', '--cap-drop=ALL', '--user=1000:1000', '--restart=no', `--label=afk.frozen.operation=${operationId}`,
    `--mount=type=bind,src=${fixture},dst=${target},readonly`, `--mount=type=bind,src=${fixture},dst=${otherPath},readonly`,
    'node:22-alpine', 'node', '-e', source);

  it.each([
    ['startup denial', denied(target), 1], ['longer path only', denied(otherPath), 0], ['reported error only', 'console.log("EROFS")', 0],
  ])('counts only the exact container and path for %s', async (_case, source, expected) => {
    const operationId = randomUUID();
    const containerId = worker(operationId, source);
    const containers = [containerId];
    let witness: Awaited<ReturnType<typeof startFrozenPermissionWitness>> | undefined;
    try {
      witness = await startFrozenPermissionWitness({ observerImageId: nativeObserverImageId!, operationId, containerId, target, timeoutMs: 10_000 });
      expect(docker('container', 'ls', '--all', '--filter', 'name=w06-permission-witness-',
        '--filter', `label=afk.frozen.operation=${operationId}`, '--format', '{{.Label "afk.frozen.managed"}}')).toBe('true');
      const unrelated = worker(randomUUID(), denied(target));
      containers.push(unrelated);
      docker('container', 'start', '--attach', unrelated);
      docker('container', 'start', '--attach', containerId);
      await expect(witness.finish()).resolves.toEqual({ cgroupId: expect.stringMatching(/^[1-9]\d*$/), deniedWrites: expected });
    } finally {
      try { await witness?.close(); }
      finally { docker('container', 'rm', '--force', ...containers); }
    }
  });
});
