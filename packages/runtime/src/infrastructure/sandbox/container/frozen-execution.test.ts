import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { DockerContainerProvider } from './docker.js';
import { captureFrozenInput } from './frozen-input.js';
import { executeFrozenContainer, FrozenCleanupError, type FrozenExecutionOptions, type FrozenExecutionOwnership } from './frozen-execution.js';
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

describe.runIf(process.env.AFK_TEST_FROZEN_DOCKER === '1')('real Docker frozen execution', () => {
  const baseImageId = process.env.AFK_TEST_FROZEN_IMAGE ?? '';
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
});
