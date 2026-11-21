import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureFrozenInput } from '../sandbox/container/frozen-input.js';
import type { ContainerProvider, FrozenContainerInspection, FrozenContainerOperations } from '../sandbox/container/types.js';
import { FrozenCleanupError } from '../sandbox/container/frozen-execution.js';
import type { FrozenVerificationRequest } from './frozen-command.js';
import * as verification from './index.js';
import * as frozenVerification from './frozen-command.js';

const roots: string[] = [];
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function archiveFiles(archive: Buffer) {
  const files = new Map<string, string>();
  for (let offset = 0; offset + 512 <= archive.length && archive[offset];) {
    const name = archive.subarray(offset, offset + 100).toString().replace(/\0.*$/, '');
    const size = Number.parseInt(archive.subarray(offset + 124, offset + 136).toString().replace(/\0.*$/, '').trim(), 8);
    if (archive[offset + 156] !== 53) files.set(name, archive.subarray(offset + 512, offset + 512 + size).toString());
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'frozen-checker-')));
  roots.push(root); mkdirSync(join(root, 'deps'));
  writeFileSync(join(root, 'checker.mjs'), 'import "./deps/rule.mjs";');
  writeFileSync(join(root, 'deps/rule.mjs'), 'export const rule = "original rule";');
  const input = JSON.stringify({ marker: 'original request' });
  const content = JSON.stringify({ approvalRequired: true });
  const request: FrozenVerificationRequest = { version: 1, executionId: 'checker-run-1', checkerRoot: root,
    checkerDigest: captureFrozenInput(root).digest, baseImageId: `sha256:${'a'.repeat(64)}`,
    command: ['/usr/local/bin/node', '/workspace/checker.mjs', '/workspace/.verification-request.json', '/workspace/.verification-target.json'],
    input, target: { content, digest: hash(content) }, timeoutMs: 1000 };
  let operationId = ''; let command: readonly string[] = []; let exited = false;
  const imageId = `sha256:${'b'.repeat(64)}`; const containerId = 'c'.repeat(64);
  const policy = (): FrozenContainerInspection => ({ id: containerId, imageId, operationId, name: `afk-frozen-${operationId}`,
    status: exited ? 'exited' : 'created', exitCode: 0, user: '1000:1000', readOnlyRoot: true, network: 'none', capDrop: ['ALL'],
    securityOptions: ['no-new-privileges'], privileged: false, pidMode: '', ipcMode: 'private', binds: [], mounts: [],
    tmpfs: { '/scratch': 'rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000' },
    memory: 268435456, memorySwap: 268435456, nanoCpus: 1_000_000_000, pidsLimit: 64,
    entrypoint: ['/usr/bin/env'], command: ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...command], workdir: '/workspace' });
  const engine: FrozenContainerOperations = {
    buildFrozenImage: vi.fn(async identifier => { operationId = identifier; return imageId; }),
    createFrozenContainer: vi.fn(async (_identifier, _image, argv) => { command = argv; return containerId; }),
    inspectFrozenContainer: vi.fn(async () => policy()),
    startFrozenContainer: vi.fn(async () => { exited = true; return { stdout: '{"actual":"observed"}', stderr: '', code: 0 }; }),
    cleanupFrozenOperation: vi.fn(async () => undefined),
  };
  const provider = { engine: 'docker', binary: 'docker', frozen: engine } as ContainerProvider;
  return { root, request, provider, engine, input, content };
}

describe('frozen checker execution with an inert container engine', () => {
  it.each([undefined, null, {}, { onOwnership: null }, { onOwnership: true }])('rejects native execution without an ownership recorder: %j', async options => {
    const controller = new AbortController();
    controller.abort(new Error('unexpected_execution'));
    const supplied = options && { ...options, signal: controller.signal };
    await expect(frozenVerification.executeNativeFrozenVerification({} as FrozenVerificationRequest,
      supplied as unknown as Parameters<typeof frozenVerification.executeNativeFrozenVerification>[1]))
      .rejects.toThrow('frozen_ownership_journal_required');
  });

  it('never grants native execution identity to an injected engine or a copied receipt', async () => {
    const setup = fixture();
    const receipt = await verification.executeFrozenVerification(setup.provider, setup.request);
    expect(frozenVerification.isNativeFrozenVerificationObservation(receipt)).toBe(false);
    expect(frozenVerification.isNativeFrozenVerificationObservation(structuredClone(receipt))).toBe(false);
    expect(frozenVerification.isNativeFrozenVerificationObservation(undefined)).toBe(false);
  });

  it('hands over captured checker dependencies and bound request/target bytes', async () => {
    const setup = fixture(); const originalCommand = [...setup.request.command];
    let files: Map<string, string> | undefined;
    const build = vi.mocked(setup.engine.buildFrozenImage).getMockImplementation()!;
    vi.mocked(setup.engine.buildFrozenImage).mockImplementation(async (...args) => { files = archiveFiles(args[2]); return build(...args); });
    const result = await verification.executeFrozenVerification(setup.provider, setup.request, { onOwnership: () => {
      writeFileSync(join(setup.root, 'deps/rule.mjs'), 'export const rule = "changed after capture";');
      setup.request.input = 'changed request'; setup.request.target.content = 'changed target'; setup.request.command.push('changed argv');
    } });
    expect(files!.get('input/deps/rule.mjs')).toContain('original rule');
    expect(files!.get('input/.verification-request.json')).toBe(setup.input);
    expect(files!.get('input/.verification-target.json')).toBe(setup.content);
    expect(result.protocol).toBe('verification-frozen-v1');
    expect(result.binding).toMatchObject({ executionId: 'checker-run-1', inputDigest: hash(setup.input), targetDigest: hash(setup.content) });
    expect(result.binding.command).toEqual(originalCommand);
    expect(result.result.exitCode).toBe(0);
    expect(result).not.toHaveProperty('passed');
    expect(setup.engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it.each(['checker', 'target'] as const)('rejects a changed %s digest before allocation', async kind => {
    const setup = fixture();
    if (kind === 'checker') writeFileSync(join(setup.root, 'deps/rule.mjs'), 'changed dependency');
    else setup.request.target.digest = '0'.repeat(64);
    await expect(verification.executeFrozenVerification(setup.provider, setup.request)).rejects.toThrow('digest');
    expect(setup.engine.buildFrozenImage).not.toHaveBeenCalled();
    expect(setup.engine.cleanupFrozenOperation).not.toHaveBeenCalled();
  });

  it.each(['.verification-request.json', '.verification-target.json'])('refuses a reserved %s in the checker package', async name => {
    const setup = fixture(); writeFileSync(join(setup.root, name), 'reserved');
    setup.request.checkerDigest = captureFrozenInput(setup.root).digest;
    await expect(verification.executeFrozenVerification(setup.provider, setup.request)).rejects.toThrow('reserved');
    expect(setup.engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it.each(['/workspace/.verification-request.json', '/workspace/.verification-target.json'])('requires explicit delivery of %s', async file => {
    const setup = fixture(); setup.request.command = setup.request.command.filter(argument => argument !== file);
    await expect(verification.executeFrozenVerification(setup.provider, setup.request)).rejects.toThrow();
    expect(setup.engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it('honors an already expired operation deadline before reading the checker package', async () => {
    const setup = fixture();
    await expect(verification.executeFrozenVerification(setup.provider, { ...setup.request, checkerRoot: '/missing' },
      { deadlineAt: Date.now() - 1 })).rejects.toThrow('deadline');
    expect(setup.engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it('stops before container creation if the deadline expires during image allocation', async () => {
    const setup = fixture(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let release!: () => void; let started!: () => void;
    const began = new Promise<void>(complete => { started = complete; });
    const gate = new Promise<void>(complete => { release = complete; });
    const build = vi.mocked(setup.engine.buildFrozenImage).getMockImplementation()!;
    vi.mocked(setup.engine.buildFrozenImage).mockImplementation(async (...args) => { started(); await gate; return build(...args); });
    const pending = verification.executeFrozenVerification(setup.provider, { ...setup.request, timeoutMs: 20 })
      .then(value => ({ value }), error => ({ error }));
    await began; await vi.advanceTimersByTimeAsync(25); release();
    expect(await pending).toMatchObject({ error: expect.objectContaining({ message: expect.stringContaining('deadline') }) });
    expect(setup.engine.createFrozenContainer).not.toHaveBeenCalled();
    expect(setup.engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('preserves ownership and cleanup failure rather than returning a successful receipt', async () => {
    const setup = fixture(); vi.mocked(setup.engine.cleanupFrozenOperation).mockRejectedValueOnce(new Error('owned cleanup unconfirmed'));
    await expect(verification.executeFrozenVerification(setup.provider, setup.request)).rejects.toBeInstanceOf(FrozenCleanupError);
  });

  it('waits for an in-flight allocation to settle before cancelling and cleaning up', async () => {
    const setup = fixture(); const controller = new AbortController();
    let release!: () => void; let started!: () => void;
    const began = new Promise<void>(complete => { started = complete; });
    const gate = new Promise<void>(complete => { release = complete; });
    const build = vi.mocked(setup.engine.buildFrozenImage).getMockImplementation()!;
    vi.mocked(setup.engine.buildFrozenImage).mockImplementation(async (...args) => { started(); await gate; return build(...args); });
    const reason = new Error('owned checker cancelled');
    const pending = verification.executeFrozenVerification(setup.provider, setup.request, { signal: controller.signal })
      .then(value => ({ value }), error => ({ error }));
    await began; controller.abort(reason);
    expect(setup.engine.cleanupFrozenOperation).not.toHaveBeenCalled();
    release();
    expect(await pending).toEqual({ error: reason });
    expect(setup.engine.createFrozenContainer).not.toHaveBeenCalled();
    expect(setup.engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('reports a nonzero checker exit without turning execution into domain qualification', async () => {
    const setup = fixture();
    const start = vi.mocked(setup.engine.startFrozenContainer).getMockImplementation()!;
    const inspect = vi.mocked(setup.engine.inspectFrozenContainer).getMockImplementation()!;
    vi.mocked(setup.engine.startFrozenContainer).mockImplementation(async (...args) => ({ ...await start(...args), code: 2 }));
    vi.mocked(setup.engine.inspectFrozenContainer).mockImplementation(async (...args) => {
      const inspection = await inspect(...args);
      return { ...inspection, exitCode: inspection.status === 'exited' ? 2 : 0 };
    });
    const result = await verification.executeFrozenVerification(setup.provider, setup.request);
    expect(result.result.exitCode).toBe(2);
    expect(result).not.toHaveProperty('passed');
    expect(setup.engine.cleanupFrozenOperation).toHaveBeenCalledOnce();
  });

  it('rejects an unsupported engine before allocation', async () => {
    const setup = fixture();
    await expect(verification.executeFrozenVerification({ ...setup.provider, engine: 'podman', frozen: undefined }, setup.request))
      .rejects.toThrow('supported frozen execution');
    expect(setup.engine.buildFrozenImage).not.toHaveBeenCalled();
  });

  it('keeps the original checker package bytes on disk while capture itself stays private', async () => {
    const setup = fixture(); await verification.executeFrozenVerification(setup.provider, setup.request);
    expect(readFileSync(join(setup.root, 'checker.mjs'), 'utf8')).toBe('import "./deps/rule.mjs";');
    expect(captureFrozenInput(setup.root).digest).toBe(setup.request.checkerDigest);
  });
});
