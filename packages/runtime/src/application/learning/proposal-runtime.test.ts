import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { getEventListeners, once } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { compareProposalActual, prepareAssetProposal, type ProposalInventory } from './proposals.js';
import { verifyRepositoryAssetProposal, ProposalRuntimeCleanupError, type ProposalRuntimeOptions, type ProposalRuntimeResult } from './proposal-runtime.js';
import { canonicalLearningJson } from './requests.js';
import { output } from './ledger-data.fixture.spec.js';
import { MultiRepositoryProvider } from '../../infrastructure/providers/repositories.js';
import { RepositoryLeases } from '../../infrastructure/git/repository-lease.js';
import { DockerContainerProvider } from '../../infrastructure/sandbox/container/docker.js';
import { executeFrozenContainer } from '../../infrastructure/sandbox/container/frozen-execution.js';
import type { FrozenExecutionResult } from '../../infrastructure/sandbox/container/frozen-execution.js';
import type { FrozenContainerInspection, FrozenContainerOperations } from '../../infrastructure/sandbox/container/types.js';
import type { ProviderOperationOptions, RepositoryProvider, RepositoryWorkspace } from '../../plugin-sdk/capabilities.js';

const roots: string[] = [];
const realEvidence: { kind: string; operations: string[]; result?: ProposalRuntimeResult; reason?: unknown; cleanup: 'confirmed' }[] = [];
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
const bytesDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const baseImageId = process.env.AFK_TEST_FROZEN_IMAGE ?? `sha256:${'a'.repeat(64)}`;
const directory = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'afk-proposal-runtime-')));
  roots.push(root);
  return root;
};
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
afterEach(() => { vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
afterAll(() => {
  if (process.env.AFK_TEST_PROPOSAL_EVIDENCE) writeFileSync(process.env.AFK_TEST_PROPOSAL_EVIDENCE, JSON.stringify({ baseImageId, evidence: realEvidence }, null, 2));
});

function fixture() {
  const root = directory();
  const original = 'console.log(JSON.stringify({value:"old"}));\n';
  writeFileSync(join(root, 'asset.js'), original);
  writeFileSync(join(root, 'helper.txt'), 'baseline');
  git(root, 'init', '-b', 'main');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const commit = git(root, 'rev-parse', 'HEAD');
  const inventory: ProposalInventory = { skills: [], toolSearches: ['cli', 'script', 'plugin'], tools: [{ kind: 'script', ref: 'script:fixture',
    name: 'fixture', description: 'Existing fixture', provenance: 'configured-repository', source: { root, file: join(root, 'asset.js') } }] };
  const prepared = prepareAssetProposal({ ...output.candidates[0], kind: 'tool', targetRef: 'script:fixture', title: 'Fixture tool', payload: {
    existingTools: ['script:fixture'], inputSchema: { type: 'object', properties: { key: { type: 'string', pattern: '^[a-z]+$' } }, required: ['key'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    source: 'console.log(JSON.stringify({value:"new"}));', dependencies: [], permissions: [], timeoutMs: 500,
    sideEffects: 'none', idempotency: 'Pure', recovery: 'Retry', tests: [
      { kind: 'normal', input: '{"key":"alpha"}', expected: '{"value":"new"}' },
      { kind: 'normal', input: '{"key":"beta"}', expected: '{"value":"new"}' },
      { kind: 'refusal', input: '{"key":"../unsafe"}', expected: 'Refuse unsafe input' },
    ],
  } }, inventory);
  const workspace: RepositoryWorkspace = { id: randomUUID(), runId: 'run-fixture', repository: { url: 'fixture', ref: 'main' },
    snapshot: { commit, branch: 'main', dirty: false }, path: root };
  const repository: RepositoryProvider = { id: 'configured-fixture', capabilities: { read: true, clone: true, push: false, prepare: true, checkout: true, cleanup: true },
    snapshot: vi.fn(async () => workspace.snapshot), withLifecycleLease: async (_request, operation) => operation(),
    prepare: vi.fn(async () => workspace), checkout: vi.fn(async () => workspace), cleanup: vi.fn(async () => ({ removed: true })), publish: vi.fn() };
  const provider = new DockerContainerProvider();
  let operationId = '';
  let argv: readonly string[] = [];
  let completed = false;
  let exitCode = 0;
  const imageId = `sha256:${'b'.repeat(64)}`;
  const containerId = 'c'.repeat(64);
  const inspection = (): FrozenContainerInspection => ({ id: containerId, imageId, operationId, name: `afk-frozen-${operationId}`,
    status: completed ? 'exited' : 'created', exitCode, user: '1000:1000', readOnlyRoot: true, network: 'none', capDrop: ['ALL'],
    securityOptions: ['no-new-privileges'], privileged: false, pidMode: '', ipcMode: 'private', binds: [], mounts: [],
    tmpfs: { '/scratch': 'rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000' }, memory: 268435456,
    memorySwap: 268435456, nanoCpus: 1_000_000_000, pidsLimit: 64, entrypoint: ['/usr/bin/env'],
    command: ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...argv], workdir: '/workspace' });
  const engine: FrozenContainerOperations = {
    buildFrozenImage: vi.fn(async identifier => { operationId = identifier; completed = false; return imageId; }),
    createFrozenContainer: vi.fn(async (_identifier, _image, command) => { argv = command; return containerId; }),
    inspectFrozenContainer: vi.fn(async () => inspection()),
    startFrozenContainer: vi.fn(async () => { completed = true; return { code: 0, stdout: '{"value":"new"}', stderr: '' }; }),
    cleanupFrozenOperation: vi.fn(async () => {}),
  };
  vi.spyOn(provider, 'frozen', 'get').mockReturnValue(engine);
  const options: ProposalRuntimeOptions & { signal?: ProviderOperationOptions['signal'] } = {
    repository, request: { repository: workspace.repository, runId: workspace.runId }, expectedCommit: commit, inventory,
    artifactPath: 'asset.js', baseImageId,
    binding: { scope: output.candidates[0].applicability.project, candidateId: 'd'.repeat(64), candidateVersion: 1, evidenceDigest: 'e'.repeat(64) },
    sandbox: { executeFrozen: input => executeFrozenContainer(provider, input) },
    harness: { id: 'configured-behavior', revision: 'v1', kind: 'tool', cases: prepared.checks.map(check => ({
      checkId: check.id, checkDigest: digest(check), argv: ['node', '/workspace/asset.js'], expected: { value: 'new' },
    })), observe: vi.fn(async result => ({ status: 'observed' as const, actual: JSON.parse(result.stdout), assertions: 1 })) },
    assertCurrent: vi.fn(async () => {}), recordOwnership: vi.fn(async () => {}),
  };
  return { root, prepared, options, engine, repository, workspace, original, complete: (code = 0) => { completed = true; exitCode = code; } };
}

describe('repository frozen proposal production orchestration', () => {
  it.each(['missing-registration', 'operation', 'context'] as const)('rejects %s frozen evidence before invoking the oracle', async drift => {
    const { options, prepared, repository } = fixture();
    const execute = options.sandbox.executeFrozen;
    options.sandbox.executeFrozen = async request => {
      const result = await execute(drift === 'missing-registration' ? { ...request, onOwnership: undefined } : request);
      if (drift === 'operation') return { ...result, evidence: { ...result.evidence, operationId: randomUUID() } };
      if (drift === 'context') return { ...result, evidence: { ...result.evidence, contextDigest: 'f'.repeat(64) } };
      return result;
    };
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toThrow(/ownership|registration/i);
    expect(options.harness!.observe).not.toHaveBeenCalled();
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it('rejects an earlier case operation replay even when input, command and registered ownership match', async () => {
    const { options, prepared, repository, engine } = fixture();
    const execute = options.sandbox.executeFrozen;
    let first: FrozenExecutionResult | undefined;
    options.sandbox.executeFrozen = async request => {
      if (first?.evidence.inputDigest === request.input.digest) {
        await request.onOwnership?.({ operationId: first.evidence.operationId, engine: 'docker',
          containerName: `afk-frozen-${first.evidence.operationId}`, baseImageId: first.evidence.baseImageId,
          inputDigest: first.evidence.inputDigest, contextDigest: first.evidence.contextDigest });
        return first;
      }
      const result = await execute(request);
      first ??= result;
      return result;
    };
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toThrow(/ownership|operation.*reus/i);
    expect(options.harness!.observe).toHaveBeenCalledTimes(2);
    expect(engine.startFrozenContainer).toHaveBeenCalledTimes(2);
    expect(options.recordOwnership).toHaveBeenCalledTimes(2);
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it.each([null, undefined, { cancelled: 'before allocation completed' }])('preserves cancellation %s when a pending provider callback rejects late', async reason => {
    for (const boundary of ['current', 'lease', 'snapshot', 'prepare'] as const) {
      const { options, prepared, repository, engine } = fixture();
      const controller = new AbortController();
      options.signal = { get aborted() { return controller.signal.aborted; }, get reason() { return reason; },
        addEventListener: controller.signal.addEventListener.bind(controller.signal), removeEventListener: controller.signal.removeEventListener.bind(controller.signal) };
      const rejected = async () => { controller.abort(reason); throw new Error('Late provider rejection'); };
      if (boundary === 'current') options.assertCurrent = rejected;
      else if (boundary === 'lease') repository.withLifecycleLease = rejected;
      else vi.mocked(repository[boundary]!).mockImplementation(rejected);
      const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
      expect(outcome.failed, boundary).toBe(true);
      expect(outcome.value, boundary).toBe(reason);
      expect(repository.checkout, boundary).not.toHaveBeenCalled();
      expect(repository.cleanup, boundary).not.toHaveBeenCalled();
      expect(repository.publish, boundary).not.toHaveBeenCalled();
      expect(engine.startFrozenContainer, boundary).not.toHaveBeenCalled();
      expect(getEventListeners(controller.signal, 'abort'), boundary).toHaveLength(0);
    }
  });

  it.each([null, undefined])('retains primary failure %s and the same-valued lease release failure separately', async failure => {
    const { options, prepared, repository, workspace, engine } = fixture();
    vi.mocked(repository.checkout!).mockRejectedValue(failure);
    repository.withLifecycleLease = async (_request, operation) => { try { return await operation(); } finally { throw failure; } };
    const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBeInstanceOf(AggregateError);
    expect((outcome.value as AggregateError).errors).toEqual([failure, failure]);
    expect((outcome.value as Error).cause).toBe(failure);
    expect(outcome.value).toHaveProperty('workspaceId', workspace.id);
    expect(outcome.value).toHaveProperty('runId', workspace.runId);
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('does not return verification when lease release throws %s after successful workspace cleanup', async releaseFailure => {
    const { options, prepared, repository, workspace } = fixture();
    repository.withLifecycleLease = async (_request, operation) => { try { return await operation(); } finally { throw releaseFailure; } };
    const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBeInstanceOf(AggregateError);
    expect((outcome.value as AggregateError).errors).toEqual([releaseFailure]);
    expect((outcome.value as Error).cause).toBe(releaseFailure);
    expect(outcome.value).toHaveProperty('workspaceId', workspace.id);
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it('keeps unconfirmed frozen allocation ownership when Repository lease release also fails', async () => {
    const { options, prepared, repository, workspace, engine } = fixture();
    const allocationFailure = new Error('Daemon allocation result unavailable');
    const releaseFailure = new Error('Lease release unavailable');
    vi.mocked(engine.buildFrozenImage).mockRejectedValue(allocationFailure);
    repository.withLifecycleLease = async (_request, operation) => { try { return await operation(); } finally { throw releaseFailure; } };
    const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBeInstanceOf(AggregateError);
    const error = outcome.value as AggregateError;
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0]).toHaveProperty('ownership.operationId');
    expect(error.errors[0].cause).toBe(allocationFailure);
    expect(error.errors[1]).toBe(releaseFailure);
    expect(error.cause).toBe(error.errors[0]);
    expect(outcome.value).toHaveProperty('workspaceId', workspace.id);
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('preserves both %s failures through the real Repository lease and removes its temporary worktree', async failure => {
    const { options, prepared, leases, owned } = managedFixture();
    const acquire = leases.acquire.bind(leases);
    let released = false;
    vi.spyOn(leases, 'acquire').mockImplementationOnce(async (keys, registeredTmux) => {
      const claim = await acquire(keys, registeredTmux);
      return { ...claim, release: async () => { await claim.release(); released = true; throw failure; } };
    });
    vi.spyOn(options.repository, 'checkout').mockRejectedValue(failure);
    const cleanup = vi.spyOn(options.repository, 'cleanup');
    const publish = vi.spyOn(options.repository, 'publish');
    const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBeInstanceOf(AggregateError);
    expect((outcome.value as AggregateError).errors).toEqual([failure, failure]);
    expect((outcome.value as Error).cause).toBe(failure);
    expect(released).toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(owned.size).toBe(1);
    expect([...owned].every(path => !existsSync(path))).toBe(true);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('preserves structural cancellation reason %s at every owned boundary', async reason => {
    for (const boundary of ['preflight', 'prepare', 'checkout', 'ownership', 'oracle', 'cleanup', 'lease-release']) {
      const { options, prepared, repository, workspace, engine } = fixture();
      const controller = new AbortController();
      options.signal = { get aborted() { return controller.signal.aborted; }, get reason() { return reason; },
        addEventListener: controller.signal.addEventListener.bind(controller.signal), removeEventListener: controller.signal.removeEventListener.bind(controller.signal) };
      const cancel = () => controller.abort(reason);
      if (boundary === 'preflight') cancel();
      if (boundary === 'prepare' || boundary === 'checkout') vi.mocked(repository[boundary]!).mockImplementation(async () => { cancel(); return workspace; });
      if (boundary === 'ownership') options.recordOwnership = async () => { cancel(); };
      if (boundary === 'oracle') options.harness!.observe = async () => { cancel(); return { status: 'observed', actual: {}, assertions: 1 }; };
      if (boundary === 'cleanup') vi.mocked(repository.cleanup!).mockImplementation(async () => { cancel(); return { removed: true }; });
      if (boundary === 'lease-release') repository.withLifecycleLease = async (_request, operation) => { const result = await operation(); cancel(); return result; };
      const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
      expect(outcome.failed, boundary).toBe(true);
      expect(outcome.value, boundary).toBe(reason);
      expect(repository.cleanup, boundary).toHaveBeenCalledTimes(boundary === 'preflight' ? 0 : 1);
      expect(engine.startFrozenContainer, boundary).toHaveBeenCalledTimes(['oracle', 'cleanup', 'lease-release'].includes(boundary) ? boundary === 'oracle' ? 1 : prepared.checks.length * 2 : 0);
      expect(getEventListeners(controller.signal, 'abort'), boundary).toHaveLength(0);
    }
  });

  it.each([null, undefined, false, 0, ''])('distinguishes thrown %s from successful execution and preserves cleanup failures', async failure => {
    for (const cleanupFails of [false, true]) {
      const { options, prepared, repository, engine } = fixture();
      vi.mocked(repository.checkout!).mockRejectedValue(failure);
      const cleanupError = new Error('cleanup refused');
      if (cleanupFails) vi.mocked(repository.cleanup!).mockRejectedValue(cleanupError);
      const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
      expect(outcome.failed).toBe(true);
      if (cleanupFails) {
        expect(outcome.value).toBeInstanceOf(ProposalRuntimeCleanupError);
        expect((outcome.value as AggregateError).errors).toEqual([failure, cleanupError]);
        expect((outcome.value as Error).cause).toBe(failure);
      } else expect(outcome.value).toBe(failure);
      expect(repository.cleanup).toHaveBeenCalledTimes(1);
      expect(engine.startFrozenContainer).not.toHaveBeenCalled();
    }
  });

  it.each([null, undefined])('keeps cleanup-only failure %s separate from a missing primary failure', async cleanupError => {
    const { options, prepared, repository } = fixture();
    vi.mocked(repository.cleanup!).mockRejectedValue(cleanupError);
    const outcome = await verifyRepositoryAssetProposal(prepared, options).then(() => ({ failed: false, error: undefined }), error => ({ failed: true, error }));
    expect(outcome.failed).toBe(true);
    expect(outcome.error).toBeInstanceOf(ProposalRuntimeCleanupError);
    expect((outcome.error as AggregateError).errors).toEqual([cleanupError]);
    expect((outcome.error as Error).cause).toBe(cleanupError);
  });

  it.each([null, undefined])('retains frozen ownership and exact cancellation %s when both cleanups fail', async reason => {
    const { options, prepared, repository, engine } = fixture();
    const controller = new AbortController();
    options.signal = { get aborted() { return controller.signal.aborted; }, get reason() { return reason; },
      addEventListener: controller.signal.addEventListener.bind(controller.signal), removeEventListener: controller.signal.removeEventListener.bind(controller.signal) };
    vi.mocked(engine.buildFrozenImage).mockImplementation(async () => { controller.abort(reason); return `sha256:${'b'.repeat(64)}`; });
    const frozenFailure = new Error('frozen cleanup failed');
    const repositoryFailure = new Error('repository cleanup failed');
    vi.mocked(engine.cleanupFrozenOperation).mockRejectedValue(frozenFailure);
    vi.mocked(repository.cleanup!).mockRejectedValue(repositoryFailure);
    const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), error => ({ failed: true, value: error }));
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBeInstanceOf(ProposalRuntimeCleanupError);
    const error = outcome.value as AggregateError;
    expect(error.cause).toBe(reason);
    expect(error.errors[0]).toHaveProperty('ownership.operationId');
    expect(error.errors[0].cause).toBe(reason);
    expect(error.errors[0].errors).toEqual([reason, frozenFailure]);
    expect(error.errors[1]).toBe(repositoryFailure);
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it('binds clean Git, inventory, both variants and independent oracle receipts without publication', async () => {
    const { root, options, prepared, repository } = fixture();
    const result = await verifyRepositoryAssetProposal(prepared, options);
    expect(result.status).toBe('verification-observed');
    if (result.status !== 'verification-observed') throw new Error('Expected observations');
    expect(result.assurance).toBe('docker-frozen-image');
    expect(result.comparisons).toHaveLength(prepared.checks.length);
    const first = result.comparisons[0];
    expect(first.original?.receipt.binding.version).toBe('original');
    expect(first.original?.receipt.binding.nonAssetDigest).toBe(first.proposed.receipt.binding.nonAssetDigest);
    expect(first.original?.execution.evidence.inputDigest).not.toBe(first.proposed.execution.evidence.inputDigest);
    expect(first.proposed.receipt.binding).toMatchObject({ ...options.binding, commit: options.expectedCommit, artifactDigest: prepared.artifact.digest,
      checkDigest: digest(prepared.checks[0]), oracleId: 'configured-behavior', oracleRevision: 'v1' });
    expect(first.proposed.receiptDigest).toBe(digest(first.proposed.receipt));
    expect(repository.publish).not.toHaveBeenCalled();
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(git(root, 'status', '--porcelain')).toBe('');
    expect(options.recordOwnership).toHaveBeenCalledTimes(prepared.checks.length * 2);
  });

  it.each(['dirty', 'untracked', 'ignored', 'commit', 'inventory', 'asset-path'] as const)('refuses %s before candidate execution', async change => {
    const { root, options, prepared, engine } = fixture();
    if (change === 'dirty') writeFileSync(join(root, 'helper.txt'), 'changed');
    if (change === 'untracked') writeFileSync(join(root, 'extra.txt'), 'extra');
    if (change === 'ignored') { writeFileSync(join(root, '.git', 'info', 'exclude'), 'hidden\n'); writeFileSync(join(root, 'hidden'), 'extra'); }
    if (change === 'commit') options.expectedCommit = 'f'.repeat(40);
    if (change === 'inventory') options.inventory.tools[0].provenance = 'late-change';
    if (change === 'asset-path') options.artifactPath = 'helper.txt';
    if (change === 'inventory') options.inventoryDigest = 'f'.repeat(64);
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toThrow();
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it.each(['absent', 'skill', 'case', 'oracle'] as const)('blocks unsupported %s semantics with zero allocations', async kind => {
    const { prepared, options, repository, engine } = fixture();
    if (kind === 'absent') options.harness = undefined;
    else if (kind === 'skill') options.harness!.kind = 'skill';
    else if (kind === 'case') options.harness!.cases.pop();
    else options.harness!.observe = undefined as never;
    expect(await verifyRepositoryAssetProposal(prepared, options)).toMatchObject({ status: 'blocked', code: 'oracle_unavailable' });
    expect(repository.prepare).not.toHaveBeenCalled();
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it('does not turn exit zero, candidate passed or candidate expected into business proof', async () => {
    const { options, prepared, engine, complete } = fixture();
    vi.mocked(engine.startFrozenContainer).mockImplementation(async () => { complete(); return { code: 0, stdout: '{"passed":true}', stderr: '' }; });
    options.harness!.observe = async result => ({ status: 'observed', actual: JSON.parse(result.stdout), assertions: 1 });
    const result = await verifyRepositoryAssetProposal(prepared, options);
    expect(result.status).toBe('verification-observed');
    if (result.status !== 'verification-observed') throw new Error('Expected actual comparisons');
    expect(result.comparisons.every(entry => entry.proposed.receipt.passed === false)).toBe(true);
  });

  it('retains evidence but blocks and stops later cases when the actual oracle is unknown', async () => {
    const { options, prepared, engine } = fixture();
    options.harness!.observe = async () => ({ status: 'unsupported', reason: 'No actual skill interpreter' });
    const result = await verifyRepositoryAssetProposal(prepared, options);
    expect(result).toMatchObject({ status: 'blocked', code: 'oracle_unsupported' });
    expect(engine.startFrozenContainer).toHaveBeenCalledTimes(1);
    expect(options.repository.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each(['prepare', 'checkout', 'ownership', 'oracle', 'cleanup'] as const)('preserves cancellation at %s and performs no late execution', async boundary => {
    const { options, prepared, repository, workspace, engine } = fixture();
    const controller = new AbortController();
    const reason = { boundary };
    options.signal = controller.signal;
    if (boundary === 'prepare' || boundary === 'checkout') vi.mocked(repository[boundary]!).mockImplementation(async () => { controller.abort(reason); return workspace; });
    if (boundary === 'ownership') options.recordOwnership = async () => { controller.abort(reason); };
    if (boundary === 'oracle') options.harness!.observe = async () => { controller.abort(reason); return { status: 'observed', actual: {}, assertions: 1 }; };
    if (boundary === 'cleanup') vi.mocked(repository.cleanup!).mockImplementation(async () => { controller.abort(reason); return { removed: true }; });
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toBe(reason);
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(engine.startFrozenContainer).toHaveBeenCalledTimes(['oracle', 'cleanup'].includes(boundary) ? boundary === 'oracle' ? 1 : prepared.checks.length * 2 : 0);
  });

  it('keeps the original cancellation as cause when cleanup cannot be confirmed', async () => {
    const { options, prepared, repository } = fixture();
    const controller = new AbortController();
    const reason = new Error('exact cancellation');
    options.signal = controller.signal;
    options.recordOwnership = async () => { controller.abort(reason); };
    vi.mocked(repository.cleanup!).mockRejectedValue(new Error('cleanup refused'));
    try { await verifyRepositoryAssetProposal(prepared, options); throw new Error('Expected failure'); }
    catch (error) { expect(error).toBeInstanceOf(ProposalRuntimeCleanupError); expect((error as Error).cause).toBe(reason); }
  });

  it.each([{ code: 'candidate_version_changed' }, null, undefined, false, 0, ''])('rejects binding failure %s after ownership registration before allocation', async failure => {
    const { options, prepared, engine, repository } = fixture();
    let valid = true;
    let arrived!: () => void;
    const started = new Promise<void>(accept => { arrived = accept; });
    let finish!: () => void;
    const registration = new Promise<void>(accept => { finish = accept; });
    const released = vi.fn();
    repository.withLifecycleLease = async (_request, operation) => { try { return await operation(); } finally { released(); } };
    options.assertCurrent = async () => { if (!valid) throw failure; };
    options.recordOwnership = vi.fn(async () => { arrived(); await registration; });
    const pending = verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), value => ({ failed: true, value }));
    await started;
    valid = false;
    finish();
    const outcome = await pending;
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBe(failure);
    expect(options.recordOwnership).toHaveBeenCalledTimes(1);
    expect(engine.buildFrozenImage).not.toHaveBeenCalled();
    expect(engine.createFrozenContainer).not.toHaveBeenCalled();
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
    expect(options.harness!.observe).not.toHaveBeenCalled();
    expect(engine.cleanupFrozenOperation).toHaveBeenCalledTimes(1);
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('retains binding failure %s and ownership through cleanup and lease failures after registration', async failure => {
    const { options, prepared, engine, repository } = fixture();
    let valid = true;
    const frozenFailure = new Error('frozen cleanup refused');
    const workspaceFailure = new Error('workspace cleanup refused');
    const releaseFailure = new Error('lease release refused');
    options.assertCurrent = async () => { if (!valid) throw failure; };
    options.recordOwnership = async () => { await Promise.resolve(); valid = false; };
    vi.mocked(engine.cleanupFrozenOperation).mockRejectedValue(frozenFailure);
    vi.mocked(repository.cleanup!).mockRejectedValue(workspaceFailure);
    repository.withLifecycleLease = async (_request, operation) => { await operation(); throw releaseFailure; };
    const outcome = await verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), value => ({ failed: true, value }));
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBeInstanceOf(AggregateError);
    const leaseError = outcome.value as AggregateError;
    const workspaceError = leaseError.errors[0] as ProposalRuntimeCleanupError;
    const frozenError = workspaceError.errors[0] as AggregateError;
    expect(leaseError.errors[1]).toBe(releaseFailure);
    expect(leaseError.cause).toBe(workspaceError);
    expect(workspaceError).toBeInstanceOf(ProposalRuntimeCleanupError);
    expect(workspaceError.errors[1]).toBe(workspaceFailure);
    expect(workspaceError.cause).toBe(frozenError);
    expect(frozenError.errors).toEqual([failure, frozenFailure]);
    expect(frozenError.cause).toBe(failure);
    expect(frozenError).toHaveProperty('ownership.operationId');
    expect(engine.buildFrozenImage).not.toHaveBeenCalled();
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
    expect(options.harness!.observe).not.toHaveBeenCalled();
    expect(repository.publish).not.toHaveBeenCalled();
  });

  it('rejects scope/version drift after an observation before another case or success', async () => {
    const { options, prepared, engine } = fixture();
    let observed = false;
    options.harness!.observe = async () => { observed = true; return { status: 'observed', actual: { value: 'new' }, assertions: 1 }; };
    options.assertCurrent = async () => { if (observed) throw new Error('candidate_version_changed'); };
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toThrow('candidate_version_changed');
    expect(engine.startFrozenContainer).toHaveBeenCalledTimes(1);
  });

  it('pins configured argv and expected values before lifecycle awaits', async () => {
    const { options, prepared, repository, workspace, engine } = fixture();
    vi.mocked(repository.prepare!).mockImplementation(async () => {
      options.harness!.cases[0].argv[0] = 'evil';
      options.harness!.cases[0].expected = { value: 'evil' };
      return workspace;
    });
    const result = await verifyRepositoryAssetProposal(prepared, options);
    expect(result.status).toBe('verification-observed');
    expect(vi.mocked(engine.createFrozenContainer).mock.calls[0][2][0]).toBe('node');
    if (result.status === 'verification-observed') expect(result.comparisons[0].original?.receipt.passed).toBe(true);
  });

  it('checks cancellation after the lifecycle lease has actually released', async () => {
    const { options, prepared, repository } = fixture();
    const controller = new AbortController();
    const reason = { phase: 'lease-release' };
    options.signal = controller.signal;
    repository.withLifecycleLease = async (_request, operation) => { const value = await operation(); controller.abort(reason); return value; };
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toBe(reason);
  });

  it('retains the frozen cleanup error even when the caller is cancelled', async () => {
    const { options, prepared, engine } = fixture();
    const controller = new AbortController();
    const reason = { phase: 'frozen-allocation' };
    options.signal = controller.signal;
    vi.mocked(engine.buildFrozenImage).mockImplementation(async () => { controller.abort(reason); return `sha256:${'b'.repeat(64)}`; });
    vi.mocked(engine.cleanupFrozenOperation).mockRejectedValue(new Error('Docker ownership not cleared'));
    try { await verifyRepositoryAssetProposal(prepared, options); throw new Error('Expected failure'); }
    catch (error) { expect(error).toHaveProperty('ownership'); expect(error).toHaveProperty('cause', reason); }
    expect(options.repository.cleanup).toHaveBeenCalledTimes(1);
  });

  it('preserves the unverified execution and reason when actual semantics are unsupported', async () => {
    const { options, prepared } = fixture();
    options.harness!.observe = async () => ({ status: 'unsupported', reason: 'actual tool invocation unavailable' });
    const result = await verifyRepositoryAssetProposal(prepared, options);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('Expected blocked');
    expect(result.unverified?.reason).toBe('actual tool invocation unavailable');
    expect(result.unverified?.execution.evidence.mechanism).toBe('docker-frozen-image');
    expect(result.unverified?.checkId).toBe(prepared.checks[0].id);
  });

  it('compares JSON business actuals strictly and rejects invalid or oversized observations', () => {
    expect(compareProposalActual({ second: 2, first: [false] }, { first: [false], second: 2 })).toBe(true);
    expect(compareProposalActual({ passed: true }, { value: 'new' })).toBe(false);
    for (const value of [undefined, NaN, Infinity, new Date(), 'x'.repeat(32769)]) expect(() => compareProposalActual(value, null)).toThrow();
  });

  it('supports the Repository provider structural signal and removes its listener', async () => {
    const { options, prepared } = fixture();
    const controller = new AbortController();
    Object.assign(options, { signal: { get aborted() { return controller.signal.aborted; }, get reason() { return controller.signal.reason; },
      addEventListener: controller.signal.addEventListener.bind(controller.signal), removeEventListener: controller.signal.removeEventListener.bind(controller.signal) } });
    expect((await verifyRepositoryAssetProposal(prepared, options)).status).toBe('verification-observed');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['hidden-content', 'hidden-mode'] as const)('checks committed bytes despite clean status for %s', async change => {
    const { root, options, prepared, engine } = fixture();
    git(root, 'update-index', '--assume-unchanged', 'helper.txt');
    if (change === 'hidden-content') writeFileSync(join(root, 'helper.txt'), 'different bytes');
    else chmodSync(join(root, 'helper.txt'), 0o755);
    expect(git(root, 'status', '--porcelain')).toBe('');
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toThrow(/bytes or mode/);
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it('waits for a late prepare allocation then cleans it without checkout or execution', async () => {
    const { options, prepared, workspace, repository, engine } = fixture();
    const controller = new AbortController();
    options.signal = controller.signal;
    const reason = { late: 'prepare' };
    let allocated!: () => void;
    const started = new Promise<void>(accept => { allocated = accept; });
    let finish!: (workspace: RepositoryWorkspace) => void;
    vi.mocked(repository.prepare!).mockImplementation(() => { allocated(); return new Promise(accept => { finish = accept; }); });
    let settled = false;
    const running = verifyRepositoryAssetProposal(prepared, options).then(() => { settled = true; }, error => { settled = true; expect(error).toBe(reason); });
    await started;
    controller.abort(reason);
    await new Promise<void>(accept => setImmediate(accept));
    expect(settled).toBe(false);
    finish(workspace);
    await running;
    expect(repository.checkout).not.toHaveBeenCalled();
    expect(repository.cleanup).toHaveBeenCalledTimes(1);
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it('does not allocate after cancellation while waiting for the Repository lease', async () => {
    const { options, prepared, repository } = fixture();
    const controller = new AbortController();
    options.signal = controller.signal;
    const reason = { queued: true };
    repository.withLifecycleLease = async (_request, operation) => { controller.abort(reason); return operation(); };
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toBe(reason);
    expect(repository.prepare).not.toHaveBeenCalled();
  });

  it('retains both failures when frozen and Repository cleanup fail after cancellation', async () => {
    const { options, prepared, engine, repository } = fixture();
    const controller = new AbortController();
    const reason = { cleanup: 'both' };
    options.signal = controller.signal;
    vi.mocked(engine.buildFrozenImage).mockImplementation(async () => { controller.abort(reason); return `sha256:${'b'.repeat(64)}`; });
    vi.mocked(engine.cleanupFrozenOperation).mockRejectedValue(new Error('frozen failed'));
    vi.mocked(repository.cleanup!).mockRejectedValue(new Error('repository failed'));
    try { await verifyRepositoryAssetProposal(prepared, options); throw new Error('Expected failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(ProposalRuntimeCleanupError);
      expect((error as AggregateError).errors[0]).toHaveProperty('ownership');
      expect(error).toHaveProperty('cause', reason);
    }
  });

  it('refuses generic lifecycle providers without a managed lease', async () => {
    const { options, prepared, repository } = fixture();
    repository.withLifecycleLease = undefined;
    expect(await verifyRepositoryAssetProposal(prepared, options)).toMatchObject({ status: 'blocked', code: 'repository_unavailable' });
    expect(repository.prepare).not.toHaveBeenCalled();
  });

  it('does not accept matching business actual with a failed process exit', async () => {
    const { options, prepared, engine, complete } = fixture();
    vi.mocked(engine.startFrozenContainer).mockImplementation(async () => { complete(7); return { code: 7, stdout: '{"value":"new"}', stderr: '' }; });
    const result = await verifyRepositoryAssetProposal(prepared, options);
    if (result.status !== 'verification-observed') throw new Error('Expected actual observations');
    expect(result.comparisons.every(entry => !entry.proposed.receipt.passed && entry.proposed.execution.exitCode === 7)).toBe(true);
  });

  it('adds a new asset from the same captured baseline without inventing an original variant', async () => {
    const { options, prepared } = fixture();
    const proposal = { ...prepared.proposal, targetRef: undefined };
    if (proposal.kind !== 'tool') throw new Error('Expected tool');
    proposal.title = 'New unique formatter';
    proposal.payload = { ...proposal.payload, existingTools: [] };
    options.inventory = { skills: [], tools: [], toolSearches: ['cli', 'script', 'plugin'] };
    const fresh = prepareAssetProposal(proposal, options.inventory);
    options.artifactPath = 'new.js';
    const result = await verifyRepositoryAssetProposal(fresh, options);
    if (result.status !== 'verification-observed') throw new Error('Expected observations');
    expect(result.comparisons.every(entry => entry.original === undefined)).toBe(true);
    expect(options.recordOwnership).toHaveBeenCalledTimes(fresh.checks.length);
  });

  it.each(['id', 'runId', 'path', 'repository', 'dirty', 'commit'] as const)('rejects checkout %s drift and cleans only the allocated workspace', async field => {
    const { options, prepared, repository, workspace, engine } = fixture();
    const next = { ...workspace, snapshot: { ...workspace.snapshot }, repository: { ...workspace.repository } };
    if (field === 'id') next.id = 'foreign-workspace';
    if (field === 'runId') next.runId = 'foreign-run';
    if (field === 'path') next.path = directory();
    if (field === 'repository') next.repository = { url: 'foreign', ref: 'main' };
    if (field === 'dirty') next.snapshot.dirty = true;
    if (field === 'commit') next.snapshot.commit = 'f'.repeat(40);
    vi.mocked(repository.checkout!).mockResolvedValue(next);
    await expect(verifyRepositoryAssetProposal(prepared, options)).rejects.toThrow(/ownership|baseline|relocated/);
    expect(repository.cleanup).toHaveBeenCalledWith({ workspaceId: workspace.id }, expect.anything());
    expect(engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it('binds an inventory catalog subdirectory to an explicit repository-relative artifact root', async () => {
    const { root, options, prepared, workspace } = fixture();
    mkdirSync(join(root, 'catalog'));
    git(root, 'mv', 'asset.js', 'catalog/asset.js');
    git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'move catalog');
    options.expectedCommit = git(root, 'rev-parse', 'HEAD');
    Object.assign(workspace.snapshot, { commit: options.expectedCommit });
    options.inventory.tools[0].source = { root: join(root, 'catalog'), file: join(root, 'catalog', 'asset.js') };
    Object.assign(options, { inventoryRoot: root });
    options.artifactPath = 'catalog/asset.js';
    for (const check of options.harness!.cases) check.argv = ['node', '/workspace/catalog/asset.js'];
    const result = await verifyRepositoryAssetProposal(prepared, options);
    if (result.status !== 'verification-observed') throw new Error('Expected observations');
    expect(result.comparisons[0].proposed.receipt.binding.artifactPath).toBe('catalog/asset.js');
  });
});

function managedFixture() {
  const test = fixture();
  vi.restoreAllMocks();
  const managedRoot = directory();
  const owned = new Set<string>();
  const store = {
    ensureCheckout: async (_url: string, path: string, branch: string) => { git(test.root, 'worktree', 'add', '--detach', path, branch); owned.add(path); },
    ownsCheckout: async (path: string) => owned.has(path),
    withCheckoutLock: async <Result>(_path: string, operation: () => Promise<Result>) => operation(),
  };
  const leases = new RepositoryLeases(join(managedRoot, '.leases'));
  test.options.repository = new MultiRepositoryProvider({ repositories: [{ name: 'fixture', path: test.root, remoteUrl: 'https://fixture.invalid/repo.git',
    baseBranch: 'main', leaseKey: 'gitlab:fixture.invalid/repo' }], managed: { workspaceRoot: managedRoot, store, leases } });
  const provider = new DockerContainerProvider();
  test.options.sandbox = { executeFrozen: request => executeFrozenContainer(provider, request) };
  return { ...test, provider, owned, leases };
}

describe.runIf(process.env.AFK_TEST_FROZEN_DOCKER === '1')('real temporary Git and Docker production orchestration', () => {
  it('rejects a binding revoked while durable registration waits without executing the captured source', async () => {
    const { options, prepared, owned } = managedFixture();
    const publish = vi.spyOn(options.repository, 'publish');
    const observe = vi.mocked(options.harness!.observe);
    const failure = { code: 'candidate_version_changed' };
    let valid = true;
    let arrived!: () => void;
    const started = new Promise<void>(accept => { arrived = accept; });
    let finish!: () => void;
    const registration = new Promise<void>(accept => { finish = accept; });
    const operations: string[] = [];
    options.assertCurrent = async () => { if (!valid) throw failure; };
    options.recordOwnership = async ownership => { operations.push(ownership.operationId); arrived(); await registration; };
    const execute = options.sandbox.executeFrozen;
    const executions: FrozenExecutionResult[] = [];
    options.sandbox.executeFrozen = async request => { const result = await execute(request); executions.push(result); return result; };
    const pending = verifyRepositoryAssetProposal(prepared, options).then(value => ({ failed: false, value }), value => ({ failed: true, value }));
    await started;
    valid = false;
    finish();
    const outcome = await pending;
    expect(outcome.failed).toBe(true);
    expect(outcome.value).toBe(failure);
    expect(executions).toEqual([]);
    expect(observe).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(owned.size).toBe(1);
    expect([...owned].every(path => !existsSync(path))).toBe(true);
    expect(operations).toHaveLength(1);
    for (const operation of operations) assertNoDockerResources(operation);
    realEvidence.push({ kind: 'registration-binding-revoked', operations, reason: failure, cleanup: 'confirmed' });
  }, 90_000);

  it('observes real variants under concurrent source writes and leaves unknown business semantics blocked', async () => {
    const { root, prepared, options, provider, owned } = managedFixture();
    for (const check of options.harness!.cases) check.argv = ['node', '-e',
      'if(require("fs").readFileSync("/workspace/helper.txt","utf8")!=="baseline")throw Error("live tree leaked");require("/workspace/asset.js")'];
    options.harness!.observe = async (result, check) => check.checkId === prepared.checks[0].id
      ? { status: 'observed', actual: JSON.parse(result.stdout), assertions: 2 }
      : { status: 'unsupported', reason: 'This fixture has no independent oracle for remaining business cases' };
    const operations: string[] = [];
    options.recordOwnership = async operation => { operations.push(operation.operationId); };
    options.sandbox = { executeFrozen: async request => {
      const helper = join([...owned][0], 'helper.txt');
      const writer = spawn(process.execPath, ['-e', 'const fs=require("fs");fs.writeFileSync(process.argv[1],"live-mutated");process.send("written");setInterval(()=>fs.writeFileSync(process.argv[1],"live-mutated"),5)', helper],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const closed = new Promise<void>(accept => writer.once('close', () => accept()));
      try {
        await once(writer, 'message', { signal: AbortSignal.timeout(5000) });
        expect(readFileSync(helper, 'utf8')).toBe('live-mutated');
        const result = await executeFrozenContainer(provider, request);
        expect(writer.exitCode).toBeNull();
        return result;
      } finally { writer.kill('SIGKILL'); await closed; writeFileSync(helper, 'baseline'); }
    } };
    const result = await verifyRepositoryAssetProposal(prepared, options);
    expect(result.status).toBe('blocked');
    if (result.status !== 'blocked') throw new Error('Expected remaining unknown semantics to block');
    expect(result.code).toBe('oracle_unsupported');
    expect(result.observations[0].receipt.passed).toBe(false);
    expect(result.observations[1].receipt.passed).toBe(true);
    expect(result.observations[0].receipt.binding.nonAssetDigest).toBe(result.observations[1].receipt.binding.nonAssetDigest);
    expect(result.unverified?.execution.evidence.mechanism).toBe('docker-frozen-image');
    for (const entry of result.observations) {
      expect(() => execFileSync('docker', ['container', 'inspect', entry.execution.evidence.containerId], { stdio: 'pipe' })).toThrow();
      expect(() => execFileSync('docker', ['image', 'inspect', entry.execution.evidence.imageId], { stdio: 'pipe' })).toThrow();
    }
    for (const operation of operations) assertNoDockerResources(operation);
    expect([...owned].every(path => !existsSync(path))).toBe(true);
    expect(readFileSync(join(root, 'helper.txt'), 'utf8')).toBe('baseline');
    realEvidence.push({ kind: 'concurrent-source-and-unknown-oracle', operations, result, cleanup: 'confirmed' });
  }, 120_000);

  it('cancels a real running frozen candidate and cleans Docker plus the managed Git workspace', async () => {
    const { options, prepared, owned } = managedFixture();
    const controller = new AbortController();
    options.signal = controller.signal;
    const reason = { reason: 'real proposal cancellation' };
    const operations: string[] = [];
    options.recordOwnership = async operation => { operations.push(operation.operationId); };
    for (const check of options.harness!.cases) check.argv = ['node', '-e', 'require("/workspace/asset.js");setInterval(()=>{},1000)'];
    const running = verifyRepositoryAssetProposal(prepared, options).then(value => ({ value, error: undefined }), error => ({ error }));
    let started = false;
    try {
      const deadline = Date.now() + 45_000;
      while (Date.now() < deadline && !started) {
        if (operations[0]) {
          try { started = execFileSync('docker', ['container', 'inspect', '--format', '{{.State.Running}}', `afk-frozen-${operations[0]}`], { encoding: 'utf8', stdio: 'pipe', timeout: 2000 }).trim() === 'true'; }
          catch {}
        }
        if (!started) await new Promise(accept => setTimeout(accept, 50));
      }
    } finally { controller.abort(reason); await running; }
    expect(started).toBe(true);
    expect((await running).error).toBe(reason);
    expect(operations).toHaveLength(1);
    for (const operation of operations) assertNoDockerResources(operation);
    expect([...owned].every(path => !existsSync(path))).toBe(true);
    realEvidence.push({ kind: 'running-cancellation', operations, reason, cleanup: 'confirmed' });
  }, 90_000);
});

function assertNoDockerResources(operation: string) {
  const filter = `label=afk.frozen.operation=${operation}`;
  expect(execFileSync('docker', ['container', 'ls', '-aq', '--filter', filter], { encoding: 'utf8', timeout: 5000 }).trim()).toBe('');
  expect(execFileSync('docker', ['image', 'ls', '-aq', '--filter', filter], { encoding: 'utf8', timeout: 5000 }).trim()).toBe('');
}
