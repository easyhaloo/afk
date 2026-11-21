import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DockerContainerProvider } from './docker.js';
import { captureFrozenInput, captureFrozenScratchHelper } from './frozen-input.js';
import { executeFrozenContainer, FrozenCleanupError, verifyFrozenScratchRecoveryEvidence, type FrozenExecutionOptions, type FrozenExecutionOwnership } from './frozen-execution.js';
import type { FrozenContainerInspection, FrozenContainerOperations } from './types.js';

const roots: string[] = [];
const directory = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-frozen-execution-')));
  roots.push(root);
  return root;
};
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const provider = new DockerContainerProvider();
  const imageId = `sha256:${'b'.repeat(64)}`;
  const containerId = 'c'.repeat(64);
  let operationId = '';
  let argv: readonly string[] = [];
  let completed = false;
  const inspect = (): FrozenContainerInspection => ({ id: containerId, imageId, operationId, name: `afk-frozen-${operationId}`,
    status: completed ? 'exited' : 'created', exitCode: 0, user: '1000:1000', readOnlyRoot: true, network: 'none', capDrop: ['ALL'],
    securityOptions: ['no-new-privileges'], privileged: false, pidMode: '', ipcMode: 'private', binds: [], mounts: [],
    tmpfs: { '/scratch': 'rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000' },
    memory: 268435456, memorySwap: 268435456, nanoCpus: 1_000_000_000, pidsLimit: 64,
    entrypoint: ['/usr/bin/env'], command: ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...argv], workdir: '/workspace' });
  const engine: FrozenContainerOperations = {
    buildFrozenImage: vi.fn(async identifier => { operationId = identifier; return imageId; }),
    createFrozenContainer: vi.fn(async (_identifier, _image, command) => { argv = command; return containerId; }),
    inspectFrozenContainer: vi.fn(async () => inspect()),
    startFrozenContainer: vi.fn(async () => { completed = true; return { stdout: 'actual', stderr: '', code: 0 }; }),
    cleanupFrozenOperation: vi.fn(async () => {}),
  };
  vi.spyOn(provider, 'frozen', 'get').mockReturnValue(engine);
  const options = { input: captureFrozenInput(directory()), baseImageId: `sha256:${'a'.repeat(64)}`, argv: ['node', 'asset.js'], timeoutMs: 500 };
  return { provider, engine, options, inspect };
}

describe('frozen execution preflight', () => {
  it('records the policy-checked container identity before starting the candidate', async () => {
    const { provider, engine, options } = fixture();
    const onContainer = vi.fn(async (binding: Readonly<{ operationId: string; containerId: string }>) => {
      expect(Object.isFrozen(binding)).toBe(true);
      expect(engine.inspectFrozenContainer).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(engine.startFrozenContainer).not.toHaveBeenCalled();
    });
    const result = await executeFrozenContainer(provider, { ...options, onContainer } as FrozenExecutionOptions);
    expect(onContainer).toHaveBeenCalledOnce();
    expect(onContainer).toHaveBeenCalledWith({ operationId: result.evidence.operationId,
      containerId: result.evidence.containerId });
  });

  it('cleans up without starting when independent container registration fails', async () => {
    const { provider, engine, options } = fixture();
    const failure = new Error('container registration failed');
    await expect(executeFrozenContainer(provider, { ...options, onContainer: () => { throw failure; } } as FrozenExecutionOptions))
      .rejects.toBe(failure);
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('rejects a forged scratch helper before allocating instead of ignoring the requested observation', async () => {
    const { provider, engine, options } = fixture();
    await expect(executeFrozenContainer(provider, { ...options, scratch: {
      helper: { digest: 'a'.repeat(64), architecture: 'arm64' }, artifactPath: 'asset.js', candidateVersion: 'proposed',
      callInput: '{}', resources: [{ id: 'state', path: 'state.json' }],
    } } as FrozenExecutionOptions)).rejects.toThrow(/scratch|helper/i);
    expect(engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it.each([null, undefined, false, 0, ''])('preserves a captured failure %j instead of treating it as absent', async failure => {
    const { provider, engine, options } = fixture();
    await expect(executeFrozenContainer(provider, { ...options, onOwnership: () => { throw failure; } })).rejects.toBe(failure);
    expect(engine.buildFrozenImage).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])('retains a captured %j in cleanup cause and the error list', async failure => {
    const { provider, engine, options } = fixture();
    const cleanupFailure = new Error('cleanup unavailable');
    vi.mocked(engine.cleanupFrozenOperation).mockRejectedValueOnce(cleanupFailure);
    try { await executeFrozenContainer(provider, { ...options, onOwnership: () => { throw failure; } }); throw new Error('Expected failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(FrozenCleanupError);
      expect((error as FrozenCleanupError).cause).toBe(failure);
      expect((error as FrozenCleanupError).errors).toEqual([failure, cleanupFailure]);
    }
  });

  it.each(['preflight', 'create', 'cleanup'] as const)('preserves null cancellation at %s', async phase => {
    const { provider, engine, options } = fixture();
    const controller = new AbortController();
    if (phase === 'preflight') controller.abort(null);
    if (phase === 'create') vi.mocked(engine.createFrozenContainer).mockImplementationOnce(async () => { controller.abort(null); return 'c'.repeat(64); });
    if (phase === 'cleanup') vi.mocked(engine.cleanupFrozenOperation).mockImplementationOnce(async () => { controller.abort(null); });
    await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal })).rejects.toBe(null);
  });

  it.each(['build', 'create'] as const)('keeps ownership when a late %s allocation can outlive empty inventory', async phase => {
    const { provider, engine, options } = fixture();
    const failure = new Error('allocation deadline exceeded');
    let lateResource = false;
    let finishDaemon!: () => void;
    const allocate = async () => { finishDaemon = () => { lateResource = true; }; throw failure; };
    if (phase === 'build') vi.mocked(engine.buildFrozenImage).mockImplementationOnce(allocate);
    else vi.mocked(engine.createFrozenContainer).mockImplementationOnce(allocate);
    let ownership: FrozenExecutionOwnership | undefined;
    let caught: unknown;
    try { await executeFrozenContainer(provider, { ...options, onOwnership: value => { ownership = value; } }); } catch (error) { caught = error; }
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    expect(lateResource).toBe(false);
    finishDaemon();
    expect(lateResource).toBe(true);
    expect(caught).toBeInstanceOf(FrozenCleanupError);
    expect((caught as FrozenCleanupError).cause).toBe(failure);
    expect((caught as FrozenCleanupError).ownership).toEqual(ownership);
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });
  it('pins the caller command before asynchronous image allocation', async () => {
    const { provider, engine, options } = fixture();
    const fixtureBuild = vi.mocked(engine.buildFrozenImage).getMockImplementation()!;
    vi.mocked(engine.buildFrozenImage).mockImplementationOnce(async identifier => {
      options.argv[0] = 'late-hostile-command';
      return fixtureBuild(identifier, options.baseImageId, Buffer.alloc(0), { timeoutMs: 500, maxOutputBytes: 1024 });
    });
    const result = await executeFrozenContainer(provider, options);
    expect(result.evidence.argv).toContain('node');
    expect(result.evidence.argv).not.toContain('late-hostile-command');
  });

  it.each(['imageId', 'readOnlyRoot', 'network', 'user', 'privileged', 'tmpfs', 'binds', 'command', 'pidMode', 'securityOptions'] as const)('refuses actual %s policy drift before execution', async field => {
    const { provider, engine, options, inspect } = fixture();
    const mutated = { imageId: `sha256:${'e'.repeat(64)}`, readOnlyRoot: false, network: 'bridge', user: '0', privileged: true,
      tmpfs: { '/workspace': 'rw' }, binds: ['/host:/workspace'], command: ['sh'], pidMode: 'container:another', securityOptions: ['no-new-privileges', 'seccomp=unconfined'] };
    vi.mocked(engine.inspectFrozenContainer).mockImplementation(async () => ({ ...inspect(), [field]: mutated[field] }));
    await expect(executeFrozenContainer(provider, options)).rejects.toThrow(/policy|identity/i);
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('cleans late allocation and preserves cancellation without starting a container', async () => {
    const { provider, engine, options } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancel late allocation');
    vi.mocked(engine.createFrozenContainer).mockImplementationOnce(async () => { controller.abort(reason); return 'c'.repeat(64); });
    await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal })).rejects.toBe(reason);
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it('rejects success if cleanup cannot be confirmed', async () => {
    const { provider, engine, options } = fixture();
    vi.mocked(engine.cleanupFrozenOperation).mockRejectedValueOnce(new Error('resource still alive'));
    await expect(executeFrozenContainer(provider, options)).rejects.toThrow(/cleanup/i);
  });

  it('journals ownership before allocating and does not allocate after cancellation in the journal callback', async () => {
    const { provider, engine, options } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancel before owned allocation');
    await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal, onOwnership: ownership => {
      expect(ownership.containerName).toBe(`afk-frozen-${ownership.operationId}`);
      expect(engine.buildFrozenImage).not.toHaveBeenCalled();
      controller.abort(reason);
    } })).rejects.toBe(reason);
    expect(engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it('preserves cancellation at the final cleanup return boundary', async () => {
    const { provider, engine, options } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancel during cleanup');
    vi.mocked(engine.cleanupFrozenOperation).mockImplementationOnce(async () => { controller.abort(reason); });
    await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal })).rejects.toBe(reason);
  });

  it('preserves cancellation without allocating resources', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel before allocation');
    controller.abort(reason);
    await expect(executeFrozenContainer(new DockerContainerProvider(), {
      input: captureFrozenInput(directory()), baseImageId: `sha256:${'a'.repeat(64)}`,
      argv: ['node', '--version'], timeoutMs: 1000, signal: controller.signal,
    })).rejects.toBe(reason);
  });
});

describe('bounded frozen ownership registration', () => {
  afterEach(() => { vi.useRealTimers(); });

  it.each(['deadline', 'abort'] as const)('cleans up without starting after container registration %s', async boundary => {
    vi.useFakeTimers();
    const { provider, engine, options } = fixture();
    const controller = new AbortController();
    const reason = new Error('cancel container registration');
    let release!: () => void;
    const readiness = new Promise<void>(resolve => { release = resolve; });
    const onContainer = vi.fn(() => readiness);
    const pending = executeFrozenContainer(provider, { ...options, timeoutMs: 25, signal: controller.signal, onContainer });
    const outcome = boundary === 'abort' ? expect(pending).rejects.toBe(reason)
      : expect(pending).rejects.toThrow('Frozen container registration deadline exceeded');
    await vi.advanceTimersByTimeAsync(0);
    expect(onContainer).toHaveBeenCalledOnce();
    if (boundary === 'abort') controller.abort(reason);
    await vi.advanceTimersByTimeAsync(25);
    await outcome;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  function held(mode: 'plain' | 'scratch' | 'recovery' = 'plain') {
    const test = mode === 'plain' ? fixture() : mode === 'scratch' ? scratchFixture() : recoveryFixture();
    const controller = new AbortController();
    let release!: () => void;
    let reject!: (reason: unknown) => void;
    const registration = new Promise<void>((accept, refuse) => { release = accept; reject = refuse; });
    let ownership: FrozenExecutionOwnership | undefined;
    let settled = false;
    const pending = executeFrozenContainer(test.provider, { ...test.options, timeoutMs: 20, signal: controller.signal,
      onOwnership: value => { ownership = value; return registration; } })
      .then(value => { settled = true; return { failed: false as const, value }; },
        error => { settled = true; return { failed: true as const, error }; });
    return { ...test, controller, release, reject, pending, settled: () => settled, ownership: () => ownership };
  }

  describe.each(['plain', 'scratch', 'recovery'] as const)('%s shared allocation gate', mode => {
    it('times out an unresolved ownership journal before allocating', async () => {
      vi.useFakeTimers();
      const test = held(mode);
      try {
        await vi.advanceTimersByTimeAsync(21);
        expect(test.settled()).toBe(true);
        const outcome = await test.pending;
        expect(outcome).toMatchObject({ failed: true, error: expect.objectContaining({ message: expect.stringMatching(/ownership.*deadline/i) }) });
        expect(test.engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
        expect(test.engine.cleanupFrozenOperation).toHaveBeenCalledWith(test.ownership()!.operationId,
          { timeoutMs: 15_000, maxOutputBytes: 256 * 1024 });
        expect(test.engine.buildFrozenImage).not.toHaveBeenCalled();
      } finally { test.release(); await test.pending; }
    });

    it('cancels an unresolved ownership journal without waiting for its release', async () => {
      vi.useFakeTimers();
      const test = held(mode);
      const reason = { cancelled: mode };
      try {
        test.controller.abort(reason);
        await vi.advanceTimersByTimeAsync(0);
        expect(test.settled()).toBe(true);
        expect(await test.pending).toEqual({ failed: true, error: reason });
        expect(test.engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
        expect(test.engine.buildFrozenImage).not.toHaveBeenCalled();
      } finally { test.release(); await test.pending; }
    });
  });

  it.each(['deadline', 'abort'] as const)('cannot allocate after late ownership resolution or rejection following %s', async boundary => {
    vi.useFakeTimers();
    for (const late of ['resolve', 'reject'] as const) {
      const test = held();
      try {
        if (boundary === 'abort') test.controller.abort(null);
        await vi.advanceTimersByTimeAsync(boundary === 'deadline' ? 21 : 0);
        expect(test.settled()).toBe(true);
        const outcome = await test.pending;
        expect(outcome.failed).toBe(true);
        if (boundary === 'abort') expect(outcome).toEqual({ failed: true, error: null });
        if (late === 'resolve') test.release(); else test.reject(new Error('late journal rejection'));
        await vi.advanceTimersByTimeAsync(100);
        expect(await test.pending).toBe(outcome);
        expect(test.engine.buildFrozenImage).not.toHaveBeenCalled();
        expect(test.engine.createFrozenContainer).not.toHaveBeenCalled();
        expect(test.engine.startFrozenContainer).not.toHaveBeenCalled();
        expect(test.engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally { test.release(); await test.pending; }
    }
  });

  it.each(['deadline', 'abort'] as const)('retains ownership and the exact cause if cleanup fails after journal %s', async boundary => {
    vi.useFakeTimers();
    const test = held();
    const cleanupFailure = new Error('cleanup acknowledgement missing');
    vi.mocked(test.engine.cleanupFrozenOperation).mockRejectedValueOnce(cleanupFailure);
    try {
      if (boundary === 'abort') test.controller.abort(false);
      await vi.advanceTimersByTimeAsync(boundary === 'deadline' ? 21 : 0);
      expect(test.settled()).toBe(true);
      const outcome = await test.pending;
      expect(outcome.failed).toBe(true);
      if (!outcome.failed) throw new Error('Expected ownership failure');
      expect(outcome.error).toBeInstanceOf(FrozenCleanupError);
      expect(outcome.error.ownership).toBe(test.ownership());
      expect(outcome.error.errors).toEqual([outcome.error.cause, cleanupFailure]);
      if (boundary === 'abort') expect(outcome.error.cause).toBe(false);
      else expect(outcome.error.cause.message).toMatch(/ownership.*deadline/i);
      expect(test.engine.buildFrozenImage).not.toHaveBeenCalled();
    } finally { test.release(); await test.pending; }
  });

  it.each(['synchronous', 'resolved-promise'] as const)('rejects an exhausted journal budget at %s completion before allocation', async completion => {
    vi.useFakeTimers();
    const { provider, engine, options } = fixture();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    try {
      await expect(executeFrozenContainer(provider, { ...options, timeoutMs: 20, onOwnership: () => {
        clock.mockReturnValue(1021);
        return completion === 'resolved-promise' ? Promise.resolve() : undefined;
      } })).rejects.toThrow(/ownership.*deadline/i);
      expect(engine.buildFrozenImage).not.toHaveBeenCalled();
      expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { clock.mockRestore(); }
  });

  it.each([null, undefined, false, 0, ''])('preserves asynchronous journal rejection %j and releases cancellation listeners', async reason => {
    vi.useFakeTimers();
    const { provider, engine, options } = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal,
      onOwnership: () => Promise.reject(reason) })).rejects.toBe(reason);
    expect(engine.buildFrozenImage).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allocates only after a confirmed journal and removes its deadline and abort listener', async () => {
    vi.useFakeTimers();
    const { provider, engine, options } = fixture();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = await executeFrozenContainer(provider, { ...options, signal: controller.signal, onOwnership: async ownership => {
      expect(Object.isFrozen(ownership)).toBe(true);
      expect(engine.buildFrozenImage).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(engine.buildFrozenImage).not.toHaveBeenCalled();
    } });
    expect(result.exitCode).toBe(0);
    expect(engine.buildFrozenImage).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});

interface ScratchFixtureFrame {
  revision: string;
  operationId: string;
  inputDigest: string;
  helperDigest: string;
  artifactDigest: string;
  callInputDigest: string;
  candidateVersion: string;
  invocation: { pid: number; startedIdentity: string; execConfirmed: boolean; startedMs: number; finishedMs: number; exitCode: number; signal: number | null };
  initialSampledMs: number;
  sampledMs: number;
  initial: Array<{ id: string; path: string; present: boolean; hex: string | null }>;
  final: Array<{ id: string; path: string; present: boolean; hex: string | null }>;
  stdoutHex: string;
  stderrHex: string;
  passed?: boolean;
}

function scratchFixture(artifactPath = 'asset.js') {
  const fixtureValue = fixture();
  const helperBytes = Buffer.alloc(120);
  helperBytes.set([127, 69, 76, 70, 2, 1, 1]);
  helperBytes.writeUInt16LE(2, 16);
  helperBytes.writeUInt16LE(183, 18);
  helperBytes.writeBigUInt64LE(64n, 32);
  helperBytes.writeUInt16LE(56, 54);
  helperBytes.writeUInt16LE(1, 56);
  helperBytes.writeUInt32LE(1, 64);
  const helperPath = join(directory(), 'helper');
  writeFileSync(helperPath, helperBytes);
  const helper = captureFrozenScratchHelper(helperPath, createHash('sha256').update(helperBytes).digest('hex'));
  const inputRoot = directory();
  mkdirSync(dirname(join(inputRoot, artifactPath)), { recursive: true });
  writeFileSync(join(inputRoot, artifactPath), 'candidate');
  const options: FrozenExecutionOptions = { ...fixtureValue.options, input: captureFrozenInput(inputRoot), argv: ['node', artifactPath, '{}'],
    scratch: { helper, artifactPath, candidateVersion: 'proposed', callInput: '{}', resources: [{ id: 'state', path: 'state.json' }] } };
  let mutate = (_frame: ScratchFixtureFrame) => {};
  const start = vi.mocked(fixtureValue.engine.startFrozenContainer).getMockImplementation()!;
  vi.mocked(fixtureValue.engine.startFrozenContainer).mockImplementation(async (...argumentsValue) => {
    await start(...argumentsValue);
    const frame: ScratchFixtureFrame = { revision: 'linux-native-scratch-v1', operationId: fixtureValue.inspect().operationId,
      inputDigest: options.input.digest, helperDigest: helper.digest, artifactDigest: options.input.manifest.find(entry => entry.path === artifactPath)!.digest,
      callInputDigest: createHash('sha256').update('{}').digest('hex'), candidateVersion: 'proposed',
      invocation: { pid: 7, startedIdentity: '123', execConfirmed: true, startedMs: 2, finishedMs: 3, exitCode: 23, signal: null },
      initialSampledMs: 1, sampledMs: 4, initial: [{ id: 'state', path: 'state.json', present: false, hex: null }],
      final: [{ id: 'state', path: 'state.json', present: true, hex: '7061727469616c' }], stdoutHex: '627573696e657373', stderrHex: '' };
    mutate(frame);
    return { stdout: JSON.stringify(frame), stderr: '', code: 0 };
  });
  return { ...fixtureValue, options, mutate: (callback: typeof mutate) => { mutate = callback; } };
}

describe('native scratch fact admission', () => {
  describe.each(['node', '/usr/local/bin/node'])('artifact option binding with %s', interpreter => {
    it.each(['-e', '-p', '--', '--eval', '--print', '-', '-asset.js', '-nested/asset.js'])(
      'rejects captured control-like artifact %s before ownership or allocation', async artifactPath => {
        const { provider, engine, options } = scratchFixture(artifactPath);
        const onOwnership = vi.fn();
        await expect(executeFrozenContainer(provider, { ...options, argv: [interpreter, artifactPath, '{}'], onOwnership }))
          .rejects.toThrow(/scratch|binding|artifact/i);
        expect(onOwnership).not.toHaveBeenCalled();
        for (const operation of Object.values(engine)) expect(operation).not.toHaveBeenCalled();
      });

    it.each(['asset.js', 'asset with spaces.js', 'nested dir/asset with spaces.js', 'nested/-e'])(
      'preserves the exact argv, manifest and receipt binding for %s', async artifactPath => {
        const { provider, engine, options } = scratchFixture(artifactPath);
        const argv = [interpreter, artifactPath, '{}'];
        const result = await executeFrozenContainer(provider, { ...options, argv });
        const digest = (value: string) => createHash('sha256').update(value).digest('hex');
        expect(vi.mocked(engine.createFrozenContainer).mock.calls[0]![2].slice(-4)).toEqual(['--', ...argv]);
        expect(result.evidence.scratch).toMatchObject({ inputDigest: options.input.digest, artifactDigest: digest('candidate'),
          callInputDigest: digest('{}'), argvDigest: digest(JSON.stringify(argv)), candidateVersion: 'proposed' });
        expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
      });
  });

  it('separates candidate exit and business pipes from carrier facts and preserves existing fixed policy', async () => {
    const { provider, engine, options } = scratchFixture();
    const result = await executeFrozenContainer(provider, options);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('business');
    expect(result.evidence.scratch!.invocation.exitCode).toBe(23);
    expect(result.evidence.scratch!.final.resources[0]).toMatchObject({ bytes: Buffer.from('partial').toString('base64'), present: true });
    expect(result.evidence.scratch!.historyCoverage).toBe('not-observed');
    expect(result.evidence.argv).toContain('/afk-observer/scratch-v1');
    expect(result.evidence.policy).toMatchObject({ user: '1000:1000', readOnlyRoot: true, network: 'none', capDrop: ['ALL'],
      securityOptions: ['no-new-privileges'], tmpfs: { '/scratch': 'rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000' } });
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it.each(['operationId', 'inputDigest', 'helperDigest', 'artifactDigest', 'callInputDigest', 'candidateVersion', 'revision'] as const)(
    'rejects a frame with foreign %s', async field => {
      const { provider, engine, options, mutate } = scratchFixture();
      mutate(frame => { frame[field] = 'foreign'; });
      await expect(executeFrozenContainer(provider, options)).rejects.toThrow(/scratch/);
      expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    });

  it.each(['extra-key', 'bad-hex', 'oversize-file', 'wrong-resource', 'missing-resource', 'existing-initial', 'not-exec', 'pid-one',
    'missing-start-identity', 'late-sample', 'reversed-time', 'exit-and-signal', 'too-much-output'])(
    'rejects unauthenticated or unbounded facts: %s', async failure => {
      const { provider, engine, options, mutate } = scratchFixture();
      mutate(frame => {
        const invocation = frame.invocation;
        if (failure === 'extra-key') frame.passed = true;
        if (failure === 'bad-hex') frame.stdoutHex = 'GG';
        if (failure === 'oversize-file') frame.final = [{ id: 'state', path: 'state.json', present: true, hex: 'aa'.repeat(16385) }];
        if (failure === 'wrong-resource') frame.final = [{ id: 'other', path: 'state.json', present: false, hex: null }];
        if (failure === 'missing-resource') frame.final = [];
        if (failure === 'existing-initial') frame.initial = frame.final;
        if (failure === 'not-exec') invocation.execConfirmed = false;
        if (failure === 'pid-one') invocation.pid = 1;
        if (failure === 'missing-start-identity') invocation.startedIdentity = '0';
        if (failure === 'late-sample') frame.sampledMs = 501;
        if (failure === 'reversed-time') invocation.finishedMs = 1;
        if (failure === 'exit-and-signal') invocation.signal = 9;
        if (failure === 'too-much-output') { frame.stdoutHex = 'aa'.repeat(40000); frame.stderrHex = 'bb'.repeat(40000); }
      });
      await expect(executeFrozenContainer(provider, options)).rejects.toThrow(/scratch/);
      expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    });

  it.each(['shell', 'foreign-input', 'foreign-artifact', 'foreign-version', 'resource-traversal', 'duplicate-resource', 'no-resource',
    'extra-option', 'large-output', 'control'])(
    'rejects an unsupported experiment before allocation: %s', async failure => {
      const { provider, engine, options } = scratchFixture();
      engine.killFrozenContainer = vi.fn(async () => {});
      const scratch = { ...options.scratch!, resources: [...options.scratch!.resources] };
      let proposed: FrozenExecutionOptions = { ...options, scratch };
      if (failure === 'shell') proposed = { ...proposed, argv: ['sh', 'asset.js', '{}'] };
      if (failure === 'foreign-input') scratch.callInput = 'different';
      if (failure === 'foreign-artifact') scratch.artifactPath = 'missing.js';
      if (failure === 'foreign-version') Object.assign(scratch, { candidateVersion: 'unexpected' });
      if (failure === 'resource-traversal') scratch.resources = [{ id: 'state', path: '../state' }];
      if (failure === 'duplicate-resource') scratch.resources.push(scratch.resources[0]!);
      if (failure === 'no-resource') scratch.resources = [];
      if (failure === 'extra-option') Object.assign(scratch, { passed: true });
      if (failure === 'large-output') proposed = { ...proposed, maxOutputBytes: 65537 };
      if (failure === 'control') proposed = { ...proposed, control: { kind: 'timeout', afterMs: 10 } };
      await expect(executeFrozenContainer(provider, proposed)).rejects.toThrow(/scratch/);
      expect(engine.buildFrozenImage).not.toHaveBeenCalled();
    });

  it.each(['attach', 'inspect', 'cleanup', 'external-cancel'])(
    'does not publish scratch facts after %s failure', async phase => {
      const { provider, engine, options } = scratchFixture();
      const failure = new Error(`scratch ${phase} failed`);
      const controller = new AbortController();
      if (phase === 'attach') vi.mocked(engine.startFrozenContainer).mockRejectedValueOnce(failure);
      if (phase === 'inspect') vi.mocked(engine.inspectFrozenContainer).mockResolvedValueOnce({ ...fixture().inspect(), command: ['wrong'] });
      if (phase === 'cleanup') vi.mocked(engine.cleanupFrozenOperation).mockRejectedValueOnce(failure);
      if (phase === 'external-cancel') vi.mocked(engine.cleanupFrozenOperation).mockImplementationOnce(async () => { controller.abort(failure); });
      await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal })).rejects.toThrow();
      expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    });

  it('pins resource identity before asynchronous ownership persistence', async () => {
    const { provider, options } = scratchFixture();
    const resources = [{ id: 'state', path: 'state.json' }];
    const result = await executeFrozenContainer(provider, { ...options, scratch: { ...options.scratch!, resources },
      onOwnership: () => { resources[0]!.path = 'foreign'; resources.push({ id: 'other', path: 'other' }); } });
    expect(result.evidence.scratch!.final.resources).toHaveLength(1);
    expect(result.evidence.scratch!.final.resources[0]!.path).toBe('state.json');
  });
});

function recoveryFixture() {
  const test = scratchFixture();
  const faultInput = '{"phase":"fault","key":"saved","value":7}';
  const recoveryInput = '{"phase":"recover","key":"saved","value":7}';
  const records = (value: string | null) => [{ id: 'state', path: 'state.json', bytes: value === null ? null : Buffer.from(value).toString('base64') }];
  const recovery = { callInput: recoveryInput, requireEffectHistory: false,
    assertions: { fault: records('partial:saved:7'), recovered: records('ready:saved:7'), replayed: records('ready:saved:7') } };
  const options = { ...test.options, argv: ['node', 'asset.js', faultInput],
    scratch: { ...test.options.scratch!, callInput: faultInput, recovery } };
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const resources = (value: string | null) => [{ id: 'state', path: 'state.json', present: value !== null,
    hex: value === null ? null : Buffer.from(value).toString('hex') }];
  let mutate = (_frame: Record<string, any>) => {};
  const start = vi.mocked(test.engine.startFrozenContainer).getMockImplementation()!;
  vi.mocked(test.engine.startFrozenContainer).mockImplementation(async (...argumentsValue) => {
    await start(...argumentsValue);
    const operationId = test.inspect().operationId;
    const frame: Record<string, any> = { revision: 'linux-native-scratch-recovery-v1', operationId, inputDigest: options.input.digest,
      helperDigest: options.scratch.helper.digest, artifactDigest: options.input.manifest[0]!.digest, candidateVersion: 'proposed',
      initialSampledMs: 1, initial: resources(null), phases: ['fault', 'recovery', 'replay'].map((phase, index) => ({
        phase, ordinal: index + 1, invocationId: `${operationId}:${index + 1}`,
        callInputDigest: digest(index === 0 ? faultInput : recoveryInput),
        invocation: { pid: index + 7, startedIdentity: '123', execConfirmed: true, startedMs: index * 3 + 2,
          finishedMs: index * 3 + 3, exitCode: index === 0 ? 23 : 0, signal: null },
        sampledMs: index * 3 + 4, final: resources(index === 0 ? 'partial:saved:7' : 'ready:saved:7'),
        stdoutHex: Buffer.from('constant\n').toString('hex'), stderrHex: '',
      })) };
    mutate(frame);
    return { stdout: JSON.stringify(frame), stderr: '', code: 0 };
  });
  return { ...test, options, recovery, mutate: (callback: typeof mutate) => { mutate = callback; } };
}

function boundedRecoveryFixture() {
  const test = recoveryFixture();
  const recovery = { ...test.recovery, returnAssertions: {
    fault: { exitCode: 23, signal: null, stdoutHex: Buffer.from('partial\n').toString('hex'), stderrHex: Buffer.from('fault\n').toString('hex') },
    recovery: { exitCode: 0, signal: null, stdoutHex: Buffer.from('recovered\n').toString('hex'), stderrHex: '' },
    replay: { exitCode: 0, signal: null, stdoutHex: Buffer.from('already-ready\n').toString('hex'), stderrHex: '' },
  } };
  const options = { ...test.options, scratch: { ...test.options.scratch, recovery } };
  const observe = (frame: Record<string, any>) => {
    frame.phases[0].stdoutHex = Buffer.from('partial\n').toString('hex');
    frame.phases[0].stderrHex = Buffer.from('fault\n').toString('hex');
    frame.phases[1].stdoutHex = Buffer.from('recovered\n').toString('hex');
    frame.phases[2].stdoutHex = Buffer.from('already-ready\n').toString('hex');
  };
  test.mutate(observe);
  return { ...test, options, recovery, mutate: (callback: typeof observe) => test.mutate(frame => { observe(frame); callback(frame); }) };
}

describe('bounded recovery returns and state', () => {
  it('qualifies exact saved returns with distinct recovery and replay responses and equal final resources', async () => {
    const { provider, engine, options, recovery } = boundedRecoveryFixture();
    const result = await executeFrozenContainer(provider, options);
    const evidence = result.evidence.scratch!.recovery!;
    expect(evidence).toMatchObject({ revision: 'linux-native-scratch-recovery-v2', helperRevision: 'linux-native-scratch-recovery-v1',
      contractRevision: 'bounded-recovery-return-state-v1', qualification: 'qualified-bounded-returns-and-state',
      returnAssertionsMatched: true, assertionsMatched: true, terminalStateIdempotent: true,
      trajectoryCoverage: 'observed-phase-boundaries', replayBehaviorCoverage: 'observed-phase-returns', historyCoverage: 'not-observed' });
    expect(evidence.contractDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.phases.map(phase => ({ exitCode: phase.invocation.exitCode, signal: phase.invocation.signal,
      stdoutHex: phase.stdoutHex, stderrHex: phase.stderrHex })))
      .toEqual([recovery.returnAssertions.fault, recovery.returnAssertions.recovery, recovery.returnAssertions.replay]);
    expect(evidence.boundaries.recovered.resources).toEqual(evidence.boundaries.replayed.resources);
    expect(result.stdout).toBe('partial\nrecovered\nalready-ready\n');
    expect(result.stderr).toBe('fault\n');
    expect(verifyFrozenScratchRecoveryEvidence(options, JSON.parse(JSON.stringify(evidence)), result.evidence.operationId, result.evidence.containerId)).toEqual(evidence);
    const command = vi.mocked(engine.createFrozenContainer).mock.calls[0]![2];
    expect(command[0]).toBe('/afk-observer/scratch-v1');
    expect(command.slice(-7)).toEqual(['--recovery', createHash('sha256').update(recovery.callInput).digest('hex'), recovery.callInput, '--', ...options.argv]);
  });

  it('compares original output bytes even when different bytes decode to the same UTF-8 text', async () => {
    const { provider, options, recovery, mutate } = boundedRecoveryFixture();
    recovery.returnAssertions.recovery.stdoutHex = 'ff00';
    recovery.returnAssertions.replay.stdoutHex = 'fe00';
    mutate(frame => { frame.phases[1].stdoutHex = 'ff00'; frame.phases[2].stdoutHex = 'fe00'; });
    const result = await executeFrozenContainer(provider, options);
    const evidence = result.evidence.scratch!.recovery!;
    expect(evidence.qualification).toBe('qualified-bounded-returns-and-state');
    expect(evidence.phases.slice(1).map(phase => phase.stdoutHex)).toEqual(['ff00', 'fe00']);
    const forged = JSON.parse(JSON.stringify(evidence));
    forged.phases[2].stdoutHex = 'ff00';
    expect(() => verifyFrozenScratchRecoveryEvidence(options, forged, result.evidence.operationId, result.evidence.containerId)).toThrow(/scratch|returns/i);
  });

  it('keeps effect history unsupported despite matching saved returns and final state', async () => {
    const { provider, options, recovery } = boundedRecoveryFixture();
    recovery.requireEffectHistory = true;
    const result = await executeFrozenContainer(provider, options);
    expect(result.evidence.scratch!.recovery).toMatchObject({ qualification: 'unsupported-effect-history',
      returnAssertionsMatched: true, replayBehaviorCoverage: 'observed-phase-returns', historyCoverage: 'not-observed' });
  });

  it('pins all saved return fields before asynchronous ownership persistence', async () => {
    const { provider, options, recovery } = boundedRecoveryFixture();
    const result = await executeFrozenContainer(provider, { ...options, onOwnership: async () => {
      await Promise.resolve();
      recovery.returnAssertions.fault.exitCode = 1;
      recovery.returnAssertions.recovery.stdoutHex = '00';
      recovery.returnAssertions.replay.stderrHex = '01';
      recovery.requireEffectHistory = true;
      recovery.callInput = 'foreign';
      recovery.assertions.recovered[0]!.bytes = Buffer.from('foreign').toString('base64');
      options.argv[2] = 'foreign';
    } });
    expect(result.evidence.scratch!.recovery).toMatchObject({ qualification: 'qualified-bounded-returns-and-state', returnAssertionsMatched: true });
    expect(result.evidence.scratch!.recovery!.phases[1]!.stdoutHex).toBe(Buffer.from('recovered\n').toString('hex'));
  });

  it('never upgrades an old request or a v1 receipt from added qualification fields', async () => {
    const { provider, options } = recoveryFixture();
    const result = await executeFrozenContainer(provider, options);
    const evidence = result.evidence.scratch!.recovery!;
    expect(evidence).toMatchObject({ qualification: 'unsupported-replay-behavior', returnAssertionsMatched: false, replayBehaviorCoverage: 'not-observed' });
    const forged = { ...evidence, qualification: 'qualified-bounded-returns-and-state', returnAssertionsMatched: true,
      replayBehaviorCoverage: 'observed-phase-returns' };
    expect(() => verifyFrozenScratchRecoveryEvidence(options, forged, result.evidence.operationId, result.evidence.containerId)).toThrow(/recomputation/i);
    expect(() => verifyFrozenScratchRecoveryEvidence(options, { ...forged, revision: 'linux-native-scratch-recovery-v1' },
      result.evidence.operationId, result.evidence.containerId)).toThrow(/revision/i);
  });

  it.each(['null-returns', 'missing-phase', 'extra-phase', 'null-phase', 'missing-field', 'extra-field', 'fault-zero', 'fault-large',
    'fault-fraction', 'fault-null', 'recovery-failed', 'replay-failed', 'signal', 'uppercase', 'odd-hex', 'bad-hex', 'non-string',
    'oversize', 'aggregate-output'])(
    'rejects invalid saved return assertion %s before ownership or allocation', async failure => {
      const { provider, engine, options, recovery } = boundedRecoveryFixture();
      const returns = recovery.returnAssertions as Record<string, any>;
      if (failure === 'null-returns') Object.assign(recovery, { returnAssertions: null });
      if (failure === 'missing-phase') delete returns.replay;
      if (failure === 'extra-phase') returns.other = returns.replay;
      if (failure === 'null-phase') returns.fault = null;
      if (failure === 'missing-field') delete returns.replay.stderrHex;
      if (failure === 'extra-field') returns.fault.passed = true;
      if (failure === 'fault-zero') returns.fault.exitCode = 0;
      if (failure === 'fault-large') returns.fault.exitCode = 256;
      if (failure === 'fault-fraction') returns.fault.exitCode = 1.5;
      if (failure === 'fault-null') returns.fault.exitCode = null;
      if (failure === 'recovery-failed') returns.recovery.exitCode = 1;
      if (failure === 'replay-failed') returns.replay.exitCode = 1;
      if (failure === 'signal') returns.fault.signal = 9;
      if (failure === 'uppercase') returns.fault.stdoutHex = 'FF';
      if (failure === 'odd-hex') returns.recovery.stdoutHex = 'a';
      if (failure === 'bad-hex') returns.replay.stderrHex = 'zz';
      if (failure === 'non-string') returns.fault.stderrHex = false;
      if (failure === 'oversize') returns.fault.stdoutHex = '00'.repeat(65537);
      if (failure === 'aggregate-output') { returns.fault.stdoutHex = '00'.repeat(32768); returns.recovery.stdoutHex = '00'.repeat(32768); }
      const onOwnership = vi.fn();
      await expect(executeFrozenContainer(provider, { ...options, onOwnership })).rejects.toThrow(/scratch|return|schema/i);
      expect(onOwnership).not.toHaveBeenCalled();
      for (const operation of Object.values(engine)) expect(operation).not.toHaveBeenCalled();
    });

  it.each(['fault-exit', 'fault-signal', 'fault-stdout', 'fault-stderr', 'recovery-stdout', 'recovery-stderr', 'replay-stdout', 'replay-stderr'])(
    'rejects an actual phase return differing from the saved contract: %s', async failure => {
      const { provider, engine, options, mutate } = boundedRecoveryFixture();
      mutate(frame => {
        if (failure === 'fault-exit') frame.phases[0].invocation.exitCode = 24;
        if (failure === 'fault-signal') frame.phases[0].invocation = { ...frame.phases[0].invocation, exitCode: null, signal: 9 };
        if (failure === 'fault-stdout') frame.phases[0].stdoutHex = '';
        if (failure === 'fault-stderr') frame.phases[0].stderrHex = '';
        if (failure === 'recovery-stdout') frame.phases[1].stdoutHex = '00';
        if (failure === 'recovery-stderr') frame.phases[1].stderrHex = '00';
        if (failure === 'replay-stdout') frame.phases[2].stdoutHex = frame.phases[1].stdoutHex;
        if (failure === 'replay-stderr') frame.phases[2].stderrHex = '00';
      });
      await expect(executeFrozenContainer(provider, options)).rejects.toThrow(/scratch|returns/i);
      expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    });

  it.each(['revision', 'helper-revision', 'contract-revision', 'contract-digest', 'return-flag', 'state-flag', 'idempotency-flag',
    'qualification', 'history', 'coverage', 'phase-order', 'ordinal', 'invocation-id', 'operation', 'container', 'input', 'helper', 'artifact',
    'version', 'call-input', 'argv', 'reused-process', 'no-exec', 'exit', 'signal', 'stdout', 'stderr', 'oversize-output', 'bad-hex',
    'time-order', 'late-time', 'initial-continuity', 'final-bytes', 'resource-id', 'resource-digest', 'resource-size', 'state-digest',
    'quiescence', 'process-state', 'boundary', 'extra-phase', 'extra-key'])(
    'independently rejects stored receipt drift %s with positive flags retained', async failure => {
      const { provider, options } = boundedRecoveryFixture();
      const result = await executeFrozenContainer(provider, options);
      const evidence = JSON.parse(JSON.stringify(result.evidence.scratch!.recovery!));
      expect(verifyFrozenScratchRecoveryEvidence(options, evidence, result.evidence.operationId, result.evidence.containerId))
        .toEqual(result.evidence.scratch!.recovery);
      const phase = evidence.phases[1];
      if (failure === 'revision') evidence.revision = 'linux-native-scratch-recovery-v1';
      if (failure === 'helper-revision') evidence.helperRevision = 'linux-native-scratch-recovery-v2';
      if (failure === 'contract-revision') evidence.contractRevision = 'other';
      if (failure === 'contract-digest') evidence.contractDigest = '0'.repeat(64);
      if (failure === 'return-flag') evidence.returnAssertionsMatched = false;
      if (failure === 'state-flag') evidence.assertionsMatched = false;
      if (failure === 'idempotency-flag') evidence.terminalStateIdempotent = false;
      if (failure === 'qualification') evidence.qualification = 'unsupported-effect-history';
      if (failure === 'history') phase.historyCoverage = 'complete';
      if (failure === 'coverage') evidence.replayBehaviorCoverage = 'not-observed';
      if (failure === 'phase-order') evidence.phases.reverse();
      if (failure === 'ordinal') phase.ordinal = 1;
      if (failure === 'invocation-id') phase.invocationId = evidence.phases[0].invocationId;
      if (failure === 'operation') phase.operationId = 'foreign';
      if (failure === 'container') phase.containerId = 'foreign';
      if (failure === 'input') phase.inputDigest = '0'.repeat(64);
      if (failure === 'helper') phase.helperDigest = '0'.repeat(64);
      if (failure === 'artifact') phase.artifactDigest = '0'.repeat(64);
      if (failure === 'version') phase.candidateVersion = 'original';
      if (failure === 'call-input') phase.callInputDigest = evidence.phases[0].callInputDigest;
      if (failure === 'argv') phase.argvDigest = '0'.repeat(64);
      if (failure === 'reused-process') phase.invocation = { ...phase.invocation, pid: evidence.phases[0].invocation.pid };
      if (failure === 'no-exec') phase.invocation.execConfirmed = false;
      if (failure === 'exit') phase.invocation.exitCode = 1;
      if (failure === 'signal') phase.invocation = { ...phase.invocation, exitCode: null, signal: 9 };
      if (failure === 'stdout') phase.stdoutHex = '00';
      if (failure === 'stderr') phase.stderrHex = '00';
      if (failure === 'oversize-output') phase.stdoutHex = '00'.repeat(65537);
      if (failure === 'bad-hex') phase.stdoutHex = 'FF';
      if (failure === 'time-order') phase.invocation.startedMs = 0;
      if (failure === 'late-time') phase.final.sampledMs = 501;
      if (failure === 'initial-continuity') phase.initial.resources[0].bytes = '';
      if (failure === 'final-bytes') phase.final.resources[0].bytes = 'AA==';
      if (failure === 'resource-id') phase.final.resources[0].id = 'foreign';
      if (failure === 'resource-digest') phase.final.resources[0].digest = '0'.repeat(64);
      if (failure === 'resource-size') phase.final.resources[0].size = 0;
      if (failure === 'state-digest') phase.final.stateDigest = '0'.repeat(64);
      if (failure === 'quiescence') phase.initial.quiescenceConfirmed = false;
      if (failure === 'process-state') phase.final.processState = 'not-started';
      if (failure === 'boundary') evidence.boundaries.recovered = evidence.boundaries.fault;
      if (failure === 'extra-phase') evidence.phases.push(evidence.phases[2]);
      if (failure === 'extra-key') evidence.passed = true;
      expect(() => verifyFrozenScratchRecoveryEvidence(options, evidence, result.evidence.operationId, result.evidence.containerId))
        .toThrow(/scratch|recovery|schema|identity|invocation/i);
    });

  it.each(['operation', 'container', 'unowned-helper'])(
    'rejects a valid receipt against a different trusted %s binding', async failure => {
      const { provider, options } = boundedRecoveryFixture();
      const result = await executeFrozenContainer(provider, options);
      const evidence = JSON.parse(JSON.stringify(result.evidence.scratch!.recovery!));
      expect(verifyFrozenScratchRecoveryEvidence(options, evidence, result.evidence.operationId, result.evidence.containerId)).toEqual(evidence);
      const changed = failure === 'unowned-helper'
        ? { ...options, scratch: { ...options.scratch, helper: { ...options.scratch.helper } } } : options;
      expect(() => verifyFrozenScratchRecoveryEvidence(changed, evidence,
        failure === 'operation' ? 'foreign' : result.evidence.operationId,
        failure === 'container' ? 'foreign' : result.evidence.containerId)).toThrow(/scratch|recovery|identity|invocation/i);
    });

  it.each(['missing-phase', 'missing-output', 'odd-output', 'binary-output', 'phase-output-swap', 'stream-output-swap'])(
    'rejects incomplete or redistributed raw receipt bytes: %s', async failure => {
      const { provider, options } = boundedRecoveryFixture();
      const result = await executeFrozenContainer(provider, options);
      const evidence = JSON.parse(JSON.stringify(result.evidence.scratch!.recovery!));
      expect(verifyFrozenScratchRecoveryEvidence(options, evidence, result.evidence.operationId, result.evidence.containerId)).toEqual(evidence);
      if (failure === 'missing-phase') evidence.phases.pop();
      if (failure === 'missing-output') delete evidence.phases[1].stdoutHex;
      if (failure === 'odd-output') evidence.phases[1].stdoutHex = 'f';
      if (failure === 'binary-output') evidence.phases[1].stdoutHex = 'ff';
      if (failure === 'phase-output-swap') {
        [evidence.phases[1].stdoutHex, evidence.phases[2].stdoutHex] = [evidence.phases[2].stdoutHex, evidence.phases[1].stdoutHex];
      }
      if (failure === 'stream-output-swap') {
        [evidence.phases[0].stdoutHex, evidence.phases[0].stderrHex] = [evidence.phases[0].stderrHex, evidence.phases[0].stdoutHex];
      }
      expect(() => verifyFrozenScratchRecoveryEvidence(options, evidence, result.evidence.operationId, result.evidence.containerId))
        .toThrow(/scratch|recovery|schema|identity|invocation/i);
    });

  it.each(['fault-input', 'recovery-input', 'argv', 'candidate', 'input', 'helper', 'artifact', 'resources', 'assertions',
    'returns', 'history', 'timeout', 'output-limit'])(
    'revalidates against saved options rather than receipt self-consistency after %s drift', async failure => {
      const { provider, options } = boundedRecoveryFixture();
      const result = await executeFrozenContainer(provider, options);
      const changed = JSON.parse(JSON.stringify(options)) as FrozenExecutionOptions;
      const scratch = changed.scratch!;
      Object.assign(scratch, { helper: options.scratch!.helper });
      expect(verifyFrozenScratchRecoveryEvidence(changed, result.evidence.scratch!.recovery, result.evidence.operationId, result.evidence.containerId))
        .toEqual(result.evidence.scratch!.recovery);
      const recovery = scratch.recovery!;
      if (failure === 'fault-input') Object.assign(changed, { argv: ['node', 'asset.js', '{}'], scratch: { ...scratch, callInput: '{}' } });
      if (failure === 'recovery-input') Object.assign(recovery, { callInput: '{}' });
      if (failure === 'argv') Object.assign(changed, { argv: ['/usr/local/bin/node', 'asset.js', scratch.callInput] });
      if (failure === 'candidate') Object.assign(scratch, { candidateVersion: 'original' });
      if (failure === 'input') Object.assign(changed.input, { digest: '0'.repeat(64) });
      if (failure === 'helper') Object.assign(scratch, { helper: { ...scratch.helper, digest: '0'.repeat(64) } });
      if (failure === 'artifact') Object.assign(changed.input.manifest[0]!, { digest: '0'.repeat(64) });
      if (failure === 'resources') {
        Object.assign(scratch.resources[0]!, { path: 'foreign' });
        for (const records of Object.values(recovery.assertions)) Object.assign(records[0]!, { path: 'foreign' });
      }
      if (failure === 'assertions') {
        Object.assign(recovery.assertions.recovered[0]!, { bytes: 'AA==' });
        Object.assign(recovery.assertions.replayed[0]!, { bytes: 'AA==' });
      }
      if (failure === 'returns') Object.assign(recovery.returnAssertions!.replay, { stdoutHex: '00' });
      if (failure === 'history') Object.assign(recovery, { requireEffectHistory: true });
      if (failure === 'timeout') Object.assign(changed, { timeoutMs: 501 });
      if (failure === 'output-limit') Object.assign(changed, { maxOutputBytes: 65535 });
      expect(() => verifyFrozenScratchRecoveryEvidence(changed, result.evidence.scratch!.recovery, result.evidence.operationId, result.evidence.containerId))
        .toThrow(/scratch|recovery|identity|invocation/i);
    });
});

describe('frozen scratch recovery and replay', () => {
  it('binds three ordered invocations and four observed boundaries inside one owned container', async () => {
    const { provider, engine, options, recovery } = recoveryFixture();
    const result = await executeFrozenContainer(provider, options);
    const evidence = result.evidence.scratch as unknown as Record<string, any>;
    expect(evidence.recovery.qualification).toBe('unsupported-replay-behavior');
    expect(evidence.recovery.trajectoryCoverage).toBe('observed-phase-boundaries');
    expect(evidence.recovery.replayBehaviorCoverage).toBe('not-observed');
    expect(evidence.recovery.historyCoverage).toBe('not-observed');
    expect(evidence.recovery.terminalStateIdempotent).toBe(true);
    expect(evidence.recovery.assertionsMatched).toBe(true);
    expect(evidence.recovery.boundaries.initial.resources[0].bytes).toBeNull();
    expect(evidence.recovery.boundaries.fault.resources[0].bytes).toBe(recovery.assertions.fault[0]!.bytes);
    expect(evidence.recovery.boundaries.recovered.resources[0].bytes).toBe(recovery.assertions.recovered[0]!.bytes);
    expect(evidence.recovery.boundaries.replayed.resources[0].bytes).toBe(recovery.assertions.replayed[0]!.bytes);
    expect(new Set(evidence.recovery.phases.map((phase: any) => phase.invocationId)).size).toBe(3);
    for (const [index, phase] of evidence.recovery.phases.entries()) {
      const callInput = index === 0 ? options.scratch.callInput : recovery.callInput;
      expect(phase).toMatchObject({ ordinal: index + 1, operationId: evidence.operationId, containerId: evidence.containerId,
        inputDigest: options.input.digest, artifactDigest: evidence.artifactDigest, helperDigest: evidence.helperDigest, candidateVersion: 'proposed',
        callInputDigest: createHash('sha256').update(callInput).digest('hex'),
        argvDigest: createHash('sha256').update(JSON.stringify(['node', 'asset.js', callInput])).digest('hex') });
      expect(phase.initial.processState).toBe(index === 0 ? 'not-started' : 'exited');
    }
    expect(result.stdout).toBe('constant\n'.repeat(3));
    const command = vi.mocked(engine.createFrozenContainer).mock.calls[0]![2];
    expect(command.slice(-7)).toEqual(['--recovery', createHash('sha256').update(recovery.callInput).digest('hex'), recovery.callInput, '--', ...options.argv]);
    expect(engine.buildFrozenImage).toHaveBeenCalledOnce();
    expect(engine.createFrozenContainer).toHaveBeenCalledOnce();
    expect(engine.startFrozenContainer).toHaveBeenCalledOnce();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('retains unsupported effect-history qualification even when every terminal assertion matches', async () => {
    const { provider, options, recovery } = recoveryFixture();
    recovery.requireEffectHistory = true;
    const result = await executeFrozenContainer(provider, options);
    expect((result.evidence.scratch as any).recovery).toMatchObject({ qualification: 'unsupported-effect-history',
      historyCoverage: 'not-observed', terminalStateIdempotent: true, assertionsMatched: true });
  });

  it('pins phase input and saved assertion bytes before asynchronous ownership persistence', async () => {
    const { provider, options, recovery } = recoveryFixture();
    const result = await executeFrozenContainer(provider, { ...options, onOwnership: () => {
      recovery.callInput = 'foreign'; recovery.requireEffectHistory = true;
      recovery.assertions.recovered[0]!.bytes = Buffer.from('foreign').toString('base64');
      recovery.assertions.replayed.push({ id: 'foreign', path: 'foreign', bytes: null });
    } });
    expect((result.evidence.scratch as any).recovery).toMatchObject({ qualification: 'unsupported-replay-behavior', assertionsMatched: true });
  });

  it('does not qualify an ignored no-op replay that is indistinguishable from terminal-state idempotency', async () => {
    const { provider, options } = recoveryFixture();
    const result = await executeFrozenContainer(provider, options);
    expect((result.evidence.scratch as any).recovery).toMatchObject({ qualification: 'unsupported-replay-behavior',
      replayBehaviorCoverage: 'not-observed', terminalStateIdempotent: true, assertionsMatched: true });
  });

  it.each(['revision', 'operationId', 'inputDigest', 'helperDigest', 'artifactDigest', 'candidateVersion', 'extra-envelope-key',
    'missing-phase', 'phase-order', 'ordinal', 'invocation-id', 'reused-process', 'no-exec', 'live-process', 'recovery-input', 'replay-input',
    'skipped-fault', 'failed-recovery', 'failed-replay', 'reversed-boundary', 'late-boundary', 'initial-state', 'ignored-recovery',
    'ignored-input', 'changed-replay', 'stdout-authored-state', 'extra-phase-key', 'bad-file-hex', 'candidate-history-claim'])(
    'withholds qualification for %s', async failure => {
      const { provider, engine, options, mutate } = recoveryFixture();
      mutate(frame => {
        if (['revision', 'operationId', 'inputDigest', 'helperDigest', 'artifactDigest', 'candidateVersion'].includes(failure)) frame[failure] = 'foreign';
        if (failure === 'extra-envelope-key') frame.qualified = true;
        if (failure === 'missing-phase') frame.phases.pop();
        if (failure === 'phase-order') frame.phases.reverse();
        if (failure === 'ordinal') frame.phases[1].ordinal = 1;
        if (failure === 'invocation-id') frame.phases[1].invocationId = frame.phases[0].invocationId;
        if (failure === 'reused-process') frame.phases[1].invocation = { ...frame.phases[1].invocation, pid: 7 };
        if (failure === 'no-exec') frame.phases[1].invocation.execConfirmed = false;
        if (failure === 'live-process') frame.phases[1].invocation.finishedMs = null;
        if (failure === 'recovery-input') frame.phases[1].callInputDigest = 'a'.repeat(64);
        if (failure === 'replay-input') frame.phases[2].callInputDigest = frame.phases[0].callInputDigest;
        if (failure === 'skipped-fault') frame.phases[0].invocation.exitCode = 0;
        if (failure === 'failed-recovery') frame.phases[1].invocation.exitCode = 23;
        if (failure === 'failed-replay') frame.phases[2].invocation = { ...frame.phases[2].invocation, exitCode: null, signal: 9 };
        if (failure === 'reversed-boundary') frame.phases[1].invocation.startedMs = 1;
        if (failure === 'late-boundary') frame.phases[2].sampledMs = 501;
        if (failure === 'initial-state') frame.initial = frame.phases[0].final;
        if (failure === 'ignored-recovery') frame.phases[1].final = frame.phases[0].final;
        if (failure === 'ignored-input') frame.phases[1].final[0].hex = Buffer.from('ready:other:7').toString('hex');
        if (failure === 'changed-replay') frame.phases[2].final[0].hex = Buffer.from('ready:saved:14').toString('hex');
        if (failure === 'stdout-authored-state') {
          frame.phases[1].stdoutHex = Buffer.from(JSON.stringify(frame.phases[1].final)).toString('hex');
          frame.phases[1].final = frame.phases[0].final;
        }
        if (failure === 'extra-phase-key') frame.phases[1].candidateVersion = 'original';
        if (failure === 'bad-file-hex') frame.phases[2].final[0].hex = 'zz';
        if (failure === 'candidate-history-claim') frame.phases[2].historyCoverage = 'complete';
      });
      await expect(executeFrozenContainer(provider, options)).rejects.toThrow(/scratch|recovery|identity|invocation/i);
      expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    });

  it.each(['same-input', 'nul-input', 'large-input', 'no-fault-state', 'unchanged-recovery', 'different-replay-assertion',
    'noncanonical-bytes', 'large-bytes', 'missing-resource', 'foreign-resource', 'history-type', 'extra-option', 'leading-dash'])(
    'rejects invalid saved experiment %s before allocation', async failure => {
      const { provider, engine, options, recovery } = recoveryFixture();
      if (failure === 'same-input') recovery.callInput = options.scratch.callInput;
      if (failure === 'nul-input') recovery.callInput = '\0';
      if (failure === 'large-input') recovery.callInput = 'x'.repeat(16385);
      if (failure === 'no-fault-state') recovery.assertions.fault[0]!.bytes = null;
      if (failure === 'unchanged-recovery') recovery.assertions.fault[0]!.bytes = recovery.assertions.recovered[0]!.bytes;
      if (failure === 'different-replay-assertion') recovery.assertions.replayed[0]!.bytes = '';
      if (failure === 'noncanonical-bytes') recovery.assertions.recovered[0]!.bytes = '!!!!';
      if (failure === 'large-bytes') recovery.assertions.recovered[0]!.bytes = Buffer.alloc(16385).toString('base64');
      if (failure === 'missing-resource') recovery.assertions.recovered.pop();
      if (failure === 'foreign-resource') recovery.assertions.replayed[0]!.path = 'foreign';
      if (failure === 'history-type') Object.assign(recovery, { requireEffectHistory: 'yes' });
      if (failure === 'extra-option') Object.assign(recovery, { qualified: true });
      if (failure === 'leading-dash') { options.scratch.artifactPath = '-e'; options.argv[1] = '-e'; }
      await expect(executeFrozenContainer(provider, options)).rejects.toThrow(/scratch|recovery|binding/i);
      expect(engine.buildFrozenImage).not.toHaveBeenCalled();
    });

  it.each(['helper-failure', 'timeout', 'cancel', 'cleanup', 'aggregate-output'])(
    'returns no recovery facts after %s', async failure => {
      const { provider, engine, options } = recoveryFixture();
      const controller = new AbortController();
      const start = vi.mocked(engine.startFrozenContainer).getMockImplementation()!;
      if (failure === 'timeout') vi.mocked(engine.startFrozenContainer).mockRejectedValueOnce(new Error('scratch deadline exceeded'));
      if (failure === 'helper-failure') vi.mocked(engine.startFrozenContainer).mockResolvedValueOnce({ stdout: '', stderr: 'frozen-scratch-unavailable', code: 125 });
      if (failure === 'cancel') vi.mocked(engine.startFrozenContainer).mockImplementationOnce(async (...argumentsValue) => {
        const result = await start(...argumentsValue); controller.abort(new Error('scratch cancelled')); return result;
      });
      if (failure === 'cleanup') vi.mocked(engine.cleanupFrozenOperation).mockRejectedValueOnce(new Error('owned cleanup unavailable'));
      await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal,
        ...(failure === 'aggregate-output' ? { maxOutputBytes: 16 } : {}) })).rejects.toThrow();
      expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
    });
});

function controlFixture() {
  const test = fixture();
  const state = { status: 'created', exitCode: 0 };
  let finish = (_code: number) => {};
  vi.mocked(test.engine.inspectFrozenContainer).mockImplementation(async () => ({ ...test.inspect(), ...state }));
  vi.mocked(test.engine.startFrozenContainer).mockImplementation((_identifier, options) => new Promise((resolve, reject) => {
    state.status = 'running';
    const abort = () => { clearTimeout(timer); reject(options.signal?.reason); };
    finish = code => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      state.status = 'exited'; state.exitCode = code;
      resolve({ stdout: 'candidate claims cancelled', stderr: '', code });
    };
    const timer = setTimeout(() => finish(0), 150);
    options.signal?.addEventListener('abort', abort, { once: true });
  }));
  test.engine.killFrozenContainer = vi.fn(async () => { finish(137); });
  vi.mocked(test.engine.cleanupFrozenOperation).mockImplementation(async () => { finish(137); });
  return { ...test, state, finish: (code: number) => finish(code) };
}

describe('frozen host control experiments', () => {
  it.each(['cancellation', 'timeout'] as const)('records actual running, host %s and confirmed SIGKILL exit', async kind => {
    const { provider, engine, options } = controlFixture();
    const result = await executeFrozenContainer(provider, { ...options, control: { kind, afterMs: 10 } });
    expect(engine.killFrozenContainer).toHaveBeenCalledOnce();
    expect(result.exitCode).toBe(137);
    expect(result.evidence.control).toMatchObject({ outcome: 'triggered', kind, afterMs: 10, signal: 'SIGKILL',
      trigger: kind === 'timeout' ? 'host-deadline' : 'host-cancellation',
      operationId: result.evidence.operationId, containerId: result.evidence.containerId, exitCode: 137 });
    const control = result.evidence.control;
    if (control?.outcome !== 'triggered') throw new Error('Expected triggered control evidence');
    expect(control.triggeredMs - control.runningObservedMs).toBeGreaterThanOrEqual(10);
    expect(control.terminatedMs).toBeGreaterThanOrEqual(control.triggeredMs);
    expect(result.cleanup).toEqual({ containerRemoved: true, imageRemoved: true });
  });

  it('rejects unsupported control before ownership or allocation', async () => {
    const { provider, engine, options } = fixture();
    const onOwnership = vi.fn();
    await expect(executeFrozenContainer(provider, { ...options, onOwnership, control: { kind: 'timeout', afterMs: 10 } })).rejects.toThrow(/control.*support/i);
    expect(onOwnership).not.toHaveBeenCalled();
    expect(engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it.each([{ kind: 'timeout', afterMs: 0 }, { kind: 'timeout', afterMs: 501 },
    { kind: 'timeout', afterMs: 1.5 }, { kind: 'other', afterMs: 10 }, { kind: 'timeout', afterMs: 10, passed: true }])('rejects invalid control %j', async control => {
    const { provider, engine, options } = controlFixture();
    await expect(executeFrozenContainer(provider, { ...options, control: control as FrozenExecutionOptions['control'] })).rejects.toThrow(/control/i);
    expect(engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it('rejects an unconfirmed attach exit even when stdout claims cancellation', async () => {
    const { provider, engine, options } = controlFixture();
    vi.mocked(engine.startFrozenContainer).mockResolvedValueOnce({ stdout: '{"cancelled":true}', stderr: '', code: 0 });
    await expect(executeFrozenContainer(provider, { ...options, control: { kind: 'cancellation', afterMs: 10 } })).rejects.toThrow(/before|running|exit/i);
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('requires independently observed running rather than candidate stdout', async () => {
    const { provider, engine, options, inspect } = controlFixture();
    vi.mocked(engine.inspectFrozenContainer).mockImplementation(async () => inspect());
    await expect(executeFrozenContainer(provider, { ...options, control: { kind: 'timeout', afterMs: 10 } })).rejects.toThrow(/before|running|exit/i);
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
  });

  it('bounds time waiting for running and never kills a container still in created state', async () => {
    const { provider, engine, options, inspect } = controlFixture();
    vi.mocked(engine.inspectFrozenContainer).mockImplementation(async () => inspect());
    await expect(executeFrozenContainer(provider, { ...options, timeoutMs: 60, control: { kind: 'timeout', afterMs: 10 } })).rejects.toThrow(/deadline/i);
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('triggers at the full execution limit and separately confirms termination and cleanup', async () => {
    const { provider, engine, options, state, inspect } = controlFixture();
    let runningInspections = 0;
    vi.mocked(engine.inspectFrozenContainer).mockImplementation(async () => {
      if (state.status === 'running' && runningInspections++ === 0) await new Promise(resolve => setTimeout(resolve, 15));
      return { ...inspect(), ...state };
    });
    const result = await executeFrozenContainer(provider, { ...options, timeoutMs: 40, control: { kind: 'timeout', afterMs: 40 } });
    const control = result.evidence.control;
    if (control?.outcome !== 'triggered') throw new Error('Expected triggered control evidence');
    expect(control.triggeredMs - control.runningObservedMs).toBeGreaterThanOrEqual(40);
    expect(control.exitCode).toBe(137);
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])('preserves exact external reason %j when an inspection rejects on abort', async reason => {
    const { provider, engine, options, state, inspect } = controlFixture();
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'reason', { value: reason });
    vi.mocked(engine.inspectFrozenContainer).mockImplementation(async () => {
      if (state.status === 'running') { controller.abort(reason); throw new Error('inspection aborted'); }
      return { ...inspect(), ...state };
    });
    await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal, control: { kind: 'timeout', afterMs: 10 } })).rejects.toBe(reason);
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
  });

  it('retains the user output bound while allowing bounded policy inspections', async () => {
    const { provider, engine, options } = controlFixture();
    await executeFrozenContainer(provider, { ...options, maxOutputBytes: 16, control: { kind: 'timeout', afterMs: 10 } });
    expect(engine.startFrozenContainer).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ maxOutputBytes: 16 }));
    expect(vi.mocked(engine.inspectFrozenContainer).mock.calls.some(([, bounds]) => bounds.maxOutputBytes === 256 * 1024)).toBe(true);
  });

  it.each(['running', 'exited'] as const)('rejects policy drift at %s', async phase => {
    const { provider, engine, options, state, inspect } = controlFixture();
    vi.mocked(engine.inspectFrozenContainer).mockImplementation(async () => ({ ...inspect(), ...state,
      network: state.status === phase ? 'bridge' : 'none' }));
    await expect(executeFrozenContainer(provider, { ...options, control: { kind: 'timeout', afterMs: 10 } })).rejects.toThrow(/policy|identity/i);
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('refuses successful kill without an independently confirmed killed exit', async () => {
    const { provider, engine, options } = controlFixture();
    vi.mocked(engine.killFrozenContainer!).mockResolvedValueOnce();
    await expect(executeFrozenContainer(provider, { ...options, control: { kind: 'timeout', afterMs: 10 } })).rejects.toThrow(/exit|terminat/i);
  });

  it.each(['waiting', 'kill', 'cleanup'] as const)('never converts external cancellation at %s into control success', async phase => {
    const { provider, engine, options } = controlFixture();
    const controller = new AbortController();
    const reason = new Error('external validation cancelled');
    if (phase === 'kill') vi.mocked(engine.killFrozenContainer!).mockImplementationOnce(async () => { controller.abort(reason); });
    if (phase === 'cleanup') vi.mocked(engine.cleanupFrozenOperation).mockImplementationOnce(async () => { controller.abort(reason); });
    const pending = executeFrozenContainer(provider, { ...options, signal: controller.signal, control: { kind: 'timeout', afterMs: 20 } });
    const assertion = expect(pending).rejects.toBe(reason);
    if (phase === 'waiting') setTimeout(() => controller.abort(reason), 5);
    await assertion;
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('propagates attach/output failure instead of manufacturing a controlled observation', async () => {
    const { provider, engine, options } = controlFixture();
    vi.mocked(engine.startFrozenContainer).mockRejectedValueOnce(new Error('output limit exceeded'));
    await expect(executeFrozenContainer(provider, { ...options, control: { kind: 'timeout', afterMs: 10 } })).rejects.toThrow(/output/i);
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
  });

  it('rejects cleanup failure after a real controlled exit', async () => {
    const { provider, engine, options } = controlFixture();
    vi.mocked(engine.cleanupFrozenOperation).mockRejectedValueOnce(new Error('cleanup unavailable'));
    await expect(executeFrozenContainer(provider, { ...options, control: { kind: 'timeout', afterMs: 10 } })).rejects.toBeInstanceOf(FrozenCleanupError);
  });

  it.each([0, 7, 137])('authenticates fast early exit %s without inventing observed running or a trigger', async code => {
    const { provider, engine, options, state } = controlFixture();
    vi.mocked(engine.startFrozenContainer).mockImplementationOnce(async () => {
      state.status = 'exited'; state.exitCode = code;
      return { stdout: '{"cancelled":true}', stderr: 'actual stderr', code };
    });
    const result = await executeFrozenContainer(provider, { ...options, control: { kind: 'cancellation', afterMs: 10 } });
    expect(result).toMatchObject({ exitCode: code, stdout: '{"cancelled":true}', stderr: 'actual stderr' });
    expect(result.evidence.control).toMatchObject({ outcome: 'not-triggered', reason: 'early-exit', kind: 'cancellation',
      afterMs: 10, trigger: null, signal: null, triggeredMs: null, runningObservedMs: null, exitCode: code,
      containerId: result.evidence.containerId, operationId: result.evidence.operationId });
    expect(result.evidence.control!.terminatedMs).toBeGreaterThanOrEqual(0);
    expect(result.evidence.policy).toMatchObject({ status: 'exited', exitCode: code, id: result.evidence.containerId,
      operationId: result.evidence.operationId, imageId: result.evidence.imageId, network: 'none', readOnlyRoot: true });
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it.each(['cancellation', 'timeout'] as const)('authenticates exit after observed running but before %s trigger', async kind => {
    const { provider, engine, options } = controlFixture();
    const result = await executeFrozenContainer(provider, { ...options, control: { kind, afterMs: 350 } });
    expect(result.evidence.control).toMatchObject({ outcome: 'not-triggered', reason: 'early-exit', kind,
      trigger: null, signal: null, triggeredMs: null, exitCode: 0 });
    expect(result.evidence.control!.runningObservedMs).toBeTypeOf('number');
    expect(result.evidence.control!.terminatedMs).toBeGreaterThanOrEqual(result.evidence.control!.runningObservedMs!);
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
  });

  it('handles an inspected exit before the attach promise delivers its result', async () => {
    const { provider, engine, options, state, finish, inspect } = controlFixture();
    vi.mocked(engine.inspectFrozenContainer).mockImplementation(async () => {
      if (state.status === 'running') {
        state.status = 'exited'; state.exitCode = 7;
        setTimeout(() => finish(7), 5);
      }
      return { ...inspect(), ...state };
    });
    const result = await executeFrozenContainer(provider, { ...options, control: { kind: 'timeout', afterMs: 10 } });
    expect(result.evidence.control).toMatchObject({ outcome: 'not-triggered', exitCode: 7, runningObservedMs: null });
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
  });

  it.each(['code', 'policy', 'identity', 'inspect', 'attach', 'cleanup', 'deadline', 'external'] as const)('does not convert early-exit %s failure into an outcome', async failure => {
    const { provider, engine, options, state, inspect } = controlFixture();
    const controller = new AbortController();
    const reason = new Error('external cancellation');
    vi.mocked(engine.startFrozenContainer).mockImplementationOnce(async () => {
      state.status = 'exited'; state.exitCode = 7;
      if (failure === 'attach') throw new Error('attach output failure');
      return { stdout: 'candidate early-exit claim', stderr: '', code: failure === 'code' ? 0 : 7 };
    });
    vi.mocked(engine.inspectFrozenContainer).mockImplementation(async () => {
      if (state.status === 'exited') {
        if (failure === 'inspect') throw new Error('inspect failure');
        if (failure === 'external') controller.abort(reason);
        if (failure === 'deadline') await new Promise(resolve => setTimeout(resolve, 70));
      }
      return { ...inspect(), ...state, ...(state.status !== 'exited' ? {} : failure === 'policy' ? { network: 'bridge' }
        : failure === 'identity' ? { operationId: 'different-operation' } : {}) };
    });
    if (failure === 'cleanup') vi.mocked(engine.cleanupFrozenOperation).mockRejectedValueOnce(new Error('cleanup failure'));
    const pending = executeFrozenContainer(provider, { ...options, timeoutMs: failure === 'deadline' ? 60 : 500,
      signal: controller.signal, control: { kind: 'timeout', afterMs: 10 } });
    if (failure === 'external') await expect(pending).rejects.toBe(reason);
    else await expect(pending).rejects.toThrow(/code|exit|policy|identity|inspect|attach|output|cleanup|deadline/i);
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('never downgrades a kill race or kill failure into early-exit', async () => {
    const { provider, engine, options, finish } = controlFixture();
    vi.mocked(engine.killFrozenContainer!).mockImplementationOnce(async () => { finish(0); throw new Error('kill failed after exit'); });
    await expect(executeFrozenContainer(provider, { ...options, control: { kind: 'timeout', afterMs: 10 } })).rejects.toThrow(/kill/i);
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it.each([null, undefined])('preserves external cancellation %j during early-exit cleanup', async reason => {
    const { provider, engine, options, state } = controlFixture();
    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'reason', { value: reason });
    vi.mocked(engine.startFrozenContainer).mockImplementationOnce(async () => {
      state.status = 'exited'; state.exitCode = 0;
      return { stdout: '', stderr: '', code: 0 };
    });
    vi.mocked(engine.cleanupFrozenOperation).mockImplementationOnce(async () => { controller.abort(reason); });
    await expect(executeFrozenContainer(provider, { ...options, signal: controller.signal,
      control: { kind: 'timeout', afterMs: 10 } })).rejects.toBe(reason);
    expect(engine.killFrozenContainer).not.toHaveBeenCalled();
  });
});

describe.runIf(process.env.AFK_TEST_FROZEN_DOCKER === '1')('real Docker frozen execution', () => {
  const baseImageId = process.env.AFK_TEST_FROZEN_IMAGE ?? '';
  const observerImageId = process.env.AFK_TEST_FROZEN_PERMISSION_OBSERVER_IMAGE;
  const provider = new DockerContainerProvider();
  const ownerships: FrozenExecutionOwnership[] = [];
  const receipts: object[] = [];
  const execute = async (options: FrozenExecutionOptions) => {
    const result = await executeFrozenContainer(provider, { ...options, onOwnership: ownership => { ownerships.push(ownership); } });
    receipts.push(result);
    return result;
  };
  afterAll(() => {
    const resources = ownerships.map(ownership => {
      const filter = `label=afk.frozen.operation=${ownership.operationId}`;
      const containers = execFileSync('docker', ['container', 'ls', '-aq', '--filter', filter], { encoding: 'utf8' }).trim();
      const images = execFileSync('docker', ['image', 'ls', '-aq', '--filter', filter], { encoding: 'utf8' }).trim();
      expect(containers).toBe('');
      expect(images).toBe('');
      return { ...ownership, containers, images };
    });
    if (process.env.AFK_TEST_FROZEN_EVIDENCE) writeFileSync(process.env.AFK_TEST_FROZEN_EVIDENCE, JSON.stringify({ baseImageId, resources, receipts }, null, 2));
  });

  it.runIf(Boolean(observerImageId))('binds startup write denials to the native container and ignores printed claims', async () => {
    const root = directory();
    writeFileSync(join(root, 'guard'), 'unchanged');
    const input = captureFrozenInput(root);
    for (const deniedWrites of [1, 0]) {
      const command = deniedWrites ? 'try { require("node:fs").writeFileSync("/workspace/guard", "changed"); } catch (error) { console.log(error.code); }'
        : 'console.log("EROFS");';
      const result = await execute({ input, baseImageId, timeoutMs: 15_000, argv: ['node', '-e', command],
        permissionDenial: { observerImageId: observerImageId!, target: '/workspace/guard' } });
      expect(result.stdout.trim()).toBe('EROFS');
      expect(result.evidence.permissionDenial).toMatchObject({ observerImageId, target: '/workspace/guard', deniedWrites,
        operationId: result.evidence.operationId, containerId: result.evidence.containerId, errno: 'EROFS' });
    }
    expect(readFileSync(join(root, 'guard'), 'utf8')).toBe('unchanged');
  }, 60_000);

  it('executes captured bytes while an independent host process repeatedly changes the source', async () => {
    const root = directory();
    writeFileSync(join(root, 'helper.js'), 'module.exports="captured"');
    const input = captureFrozenInput(root);
    const writer = spawn(process.execPath, ['-e', `const fs=require("fs");setInterval(()=>fs.writeFileSync(process.argv[1],${JSON.stringify('module.exports="hostile"')}),5)`, join(root, 'helper.js')]);
    try {
      const result = await execute({ input, baseImageId, timeoutMs: 5000, argv: ['node', '-e',
        `const fs=require("fs");let count=0;const timer=setInterval(()=>{if(fs.readFileSync("helper.js","utf8")!==${JSON.stringify('module.exports="captured"')})process.exit(9);if(++count===8){clearInterval(timer);console.log("captured")}},50)`] });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('captured');
      expect(result.evidence.inputDigest).toBe(input.digest);
      expect(writer.exitCode).toBeNull();
      expect(readFileSync(join(root, 'helper.js'), 'utf8')).not.toBe('module.exports="captured"');
      expect(result.cleanup).toEqual({ containerRemoved: true, imageRemoved: true });
      expect(() => execFileSync('docker', ['container', 'inspect', result.evidence.containerId], { stdio: 'pipe' })).toThrow();
      expect(() => execFileSync('docker', ['image', 'inspect', result.evidence.imageId], { stdio: 'pipe' })).toThrow();
    } finally {
      writer.kill('SIGKILL');
      await new Promise(resolve => writer.once('close', resolve));
    }
  }, 60_000);

  it('enforces nonroot read-only inputs, no network, zero capabilities and isolated bounded scratch', async () => {
    const root = directory();
    const secretPath = join(directory(), 'host-only-secret');
    writeFileSync(secretPath, 'host-only-secret');
    writeFileSync(join(root, 'asset.js'), 'captured');
    const result = await execute({ input: captureFrozenInput(root), baseImageId, timeoutMs: 5000,
      argv: ['node', '-e', `const fs=require("fs"),assert=require("assert/strict"),os=require("os");assert.equal(process.getuid(),1000);assert.throws(()=>fs.readFileSync(${JSON.stringify(secretPath)}));assert.equal(fs.existsSync("/var/run/docker.sock"),false);assert.throws(()=>fs.writeFileSync("asset.js","evil"));assert.throws(()=>fs.writeFileSync("/etc/evil","evil"));assert.equal(fs.readFileSync("/proc/self/status","utf8").match(/CapEff:\\s+(\\w+)/)[1],"0000000000000000");assert.deepEqual(Object.keys(os.networkInterfaces()),["lo"]);assert.equal(process.env.GITHUB_TOKEN,undefined);fs.writeFileSync("/scratch/ok","scratch");assert.throws(()=>fs.writeFileSync("/scratch/large",Buffer.alloc(20*1024*1024)));console.log("isolated")`] });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('isolated');
  }, 60_000);

  it('cancels a running process and descendants with confirmed resource cleanup', async () => {
    const controller = new AbortController();
    const reason = new Error('cancel real frozen process');
    let containerId = '';
    const original = provider.startFrozenContainer.bind(provider);
    provider.startFrozenContainer = async (identifier, options) => {
      containerId = identifier;
      const running = original(identifier, options);
      void running.catch(() => {});
      let nodes = 0;
      for (let attempt = 0; attempt < 30 && nodes < 2; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const processes = execFileSync('docker', ['top', identifier, '-eo', 'pid,comm'], { encoding: 'utf8' });
        nodes = processes.split('\n').filter(line => line.trim().split(/\s+/).at(-1) === 'node').length;
      }
      expect(nodes).toBeGreaterThanOrEqual(2);
      controller.abort(reason);
      return running;
    };
    try {
      await expect(execute({ input: captureFrozenInput(directory()), baseImageId, signal: controller.signal,
        timeoutMs: 5000, argv: ['node', '-e', 'require("child_process").spawn("node",["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});setInterval(()=>{},1000)'] })).rejects.toBe(reason);
      expect(containerId).not.toBe('');
      expect(() => execFileSync('docker', ['container', 'inspect', containerId], { stdio: 'pipe' })).toThrow();
    } finally { provider.startFrozenContainer = original; }
  }, 60_000);

  it('bounds execution time and output without accepting candidate claims as assertions', async () => {
    const input = captureFrozenInput(directory());
    const result = await execute({ input, baseImageId, timeoutMs: 2000,
      argv: ['node', '-e', 'console.log("{\\\"passed\\\":true}");process.exit(7)'] });
    expect(result.exitCode).toBe(7);
    expect(result).not.toHaveProperty('passed');
    await expect(execute({ input, baseImageId, timeoutMs: 300,
      argv: ['node', '-e', 'setInterval(()=>{},1000)'] })).rejects.toThrow(/deadline|timed out/i);
    await expect(execute({ input, baseImageId, timeoutMs: 2000, maxOutputBytes: 1024,
      argv: ['node', '-e', 'process.stdout.write("x".repeat(65536))'] })).rejects.toThrow(/output/i);
  }, 60_000);

  it('keeps concurrent callers and their cleanup isolated while preserving the preexisting base image', async () => {
    const input = captureFrozenInput(directory());
    const results = await Promise.all(['first', 'second'].map(value => execute({ input, baseImageId, timeoutMs: 4000,
      argv: ['node', '-e', `setTimeout(()=>console.log(${JSON.stringify(value)}),300)`] })));
    expect(results.map(result => result.stdout.trim())).toEqual(['first', 'second']);
    expect(new Set(results.map(result => result.evidence.operationId)).size).toBe(2);
    expect(new Set(results.map(result => result.evidence.imageId)).size).toBe(2);
    expect(results.every(result => result.cleanup.containerRemoved && result.cleanup.imageRemoved)).toBe(true);
    expect(execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', baseImageId], { encoding: 'utf8' }).trim()).toBe(baseImageId);
  }, 60_000);

  it.each(['cancellation', 'timeout'] as const)('performs host %s on a running container and descendants with no remaining resources', async kind => {
    const afterMs = kind === 'timeout' ? 5000 : 200;
    const result = await execute({ input: captureFrozenInput(directory()), baseImageId, timeoutMs: 5000,
      control: { kind, afterMs }, argv: ['node', '-e',
        'require("child_process").spawn("node",["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("not a control receipt");setInterval(()=>{},1000)'] });
    expect(result.exitCode).toBe(137);
    expect(result.evidence.control).toMatchObject({ outcome: 'triggered', kind, signal: 'SIGKILL', containerId: result.evidence.containerId,
      operationId: result.evidence.operationId, exitCode: 137 });
    const control = result.evidence.control;
    if (control?.outcome !== 'triggered') throw new Error('Expected triggered control evidence');
    expect(control.triggeredMs - control.runningObservedMs).toBeGreaterThanOrEqual(afterMs);
    expect(() => execFileSync('docker', ['container', 'inspect', result.evidence.containerId], { stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('docker', ['image', 'inspect', result.evidence.imageId], { stdio: 'pipe' })).toThrow();
  }, 60_000);

  it.each(['cancellation', 'timeout'] as const)('observes host %s of the bounded manifest scan', async kind => {
    const fixtures = new URL('../../../../../../tests/qualification/w05/scan-entry/', import.meta.url);
    const root = directory();
    for (const name of ['checkpoint.fixture.mjs', 'scan-manifest.mjs']) {
      writeFileSync(join(root, name), readFileSync(new URL(name, fixtures)));
    }
    const input = captureFrozenInput(root);
    const afterMs = kind === 'timeout' ? 5000 : 500;
    const callInput = JSON.stringify({ phase: 'wait', manifest: '9780306406157\n5901234123457' });
    const result = await execute({ input, baseImageId, timeoutMs: 5000, control: { kind, afterMs },
      argv: ['node', '/workspace/checkpoint.fixture.mjs', callInput] });
    expect([result.exitCode, result.stdout, result.stderr]).toEqual([137, '', '']);
    expect(result.evidence.control).toMatchObject({ kind, outcome: 'triggered', signal: 'SIGKILL', exitCode: 137,
      operationId: result.evidence.operationId, containerId: result.evidence.containerId });
    const control = result.evidence.control;
    if (control?.outcome !== 'triggered') throw new Error('Expected triggered manifest scan control');
    expect(control.triggeredMs - control.runningObservedMs).toBeGreaterThanOrEqual(afterMs);
    expect(result.cleanup).toEqual({ containerRemoved: true, imageRemoved: true });
  }, 60_000);

  it.each([0, 7])('records a real fast early exit %s without fake control success', async code => {
    const result = await execute({ input: captureFrozenInput(directory()), baseImageId, timeoutMs: 5000,
      control: { kind: 'timeout', afterMs: 500 }, argv: ['node', '-e', `console.log("candidate claimed cancellation");process.exit(${code})`] });
    expect(result.exitCode).toBe(code);
    expect(result.evidence.control).toMatchObject({ outcome: 'not-triggered', reason: 'early-exit', trigger: null,
      signal: null, triggeredMs: null, exitCode: code });
    expect(result.evidence.control!.runningObservedMs === null || typeof result.evidence.control!.runningObservedMs === 'number').toBe(true);
  }, 60_000);

  it('returns an observed-running baseline early exit then a separately triggered proposed experiment', async () => {
    const input = captureFrozenInput(directory());
    const baseline = await execute({ input, baseImageId, timeoutMs: 5000,
      control: { kind: 'cancellation', afterMs: 1500 }, argv: ['node', '-e', 'setTimeout(()=>process.exit(0),300)'] });
    expect(baseline.evidence.control).toMatchObject({ outcome: 'not-triggered', reason: 'early-exit', triggeredMs: null });
    expect(baseline.evidence.control!.runningObservedMs).toBeTypeOf('number');
    const proposed = await execute({ input, baseImageId, timeoutMs: 5000,
      control: { kind: 'cancellation', afterMs: 100 }, argv: ['node', '-e', 'setInterval(()=>{},1000)'] });
    expect(proposed.evidence.control).toMatchObject({ outcome: 'triggered', signal: 'SIGKILL', exitCode: 137 });
    expect(proposed.evidence.operationId).not.toBe(baseline.evidence.operationId);
    expect(proposed.evidence.containerId).not.toBe(baseline.evidence.containerId);
  }, 90_000);
});
