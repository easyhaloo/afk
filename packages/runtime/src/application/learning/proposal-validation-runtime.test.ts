import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateStore } from './candidate-store.js';
import { buildEvidencePack } from './evidence.js';
import * as evidence from './evidence.js';
import { output } from './ledger-data.fixture.spec.js';
import { prepareAssetProposal, type ProposalInventory } from './proposals.js';
import { canonicalLearningJson } from './requests.js';
import { PROPOSAL_VALIDATION_RUNTIME_REVISION } from './proposal-validation-runtime.js';
import { validateConfiguredLearningCandidate } from './validation-runtime.js';
import { learningDirectory } from './worker.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { createLearningPlugin } from '../plugins/learning.js';

const scope = 'github:acme/api';
const roots: string[] = [];
const stores: CandidateStore[] = [];
const runtimes: PluginRuntime[] = [];
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
const bytesDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(async () => {
  vi.doUnmock('./proposal-validation-runtime.js');
  vi.doUnmock('./proposal-validation.js');
  vi.restoreAllMocks();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  stores.splice(0).forEach(store => store.close());
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'proposal-production-')));
  roots.push(root);
  const privateRoot = join(root, 'private');
  const repositoryRoot = join(root, 'repository');
  mkdirSync(privateRoot, { mode: 0o700 });
  mkdirSync(repositoryRoot, { mode: 0o700 });
  const scanRoots = { skills: 'skills', cli: 'cli', script: 'script', plugin: 'plugin' };
  for (const directory of Object.values(scanRoots)) mkdirSync(join(repositoryRoot, directory), { mode: 0o700 });
  const assetPath = 'script/fixture.js';
  const original = 'console.log(JSON.stringify({value:"old"}));\n';
  writeFileSync(join(repositoryRoot, assetPath), original, { mode: 0o600 });
  const expectedCommit = 'a'.repeat(40);
  const tool = { kind: 'script' as const, ref: 'script:fixture', name: 'fixture', description: 'Known fixture tool', provenance: 'operator',
    source: { root: repositoryRoot, file: join(repositoryRoot, assetPath) } };
  const manifest = { version: 1, scope, repositoryRoot, expectedCommit, scanRoots, skills: [],
    tools: [{ ...tool, scope, expectedCommit, digest: bytesDigest(original) }] };
  const inventory: ProposalInventory = { skills: [], tools: [tool], toolSearches: ['cli', 'script', 'plugin'] };
  const inventoryFile = join(privateRoot, 'catalog.json');
  const inventoryBytes = JSON.stringify(manifest);
  writeFileSync(inventoryFile, inventoryBytes, { mode: 0o600 });
  const events = new JsonlEventStore({ root: join(root, 'events') });
  await events.append([{ id: 'finished', schemaVersion: 1, type: 'run.finished', occurredAt: '2026-11-13T00:00:00Z',
    context: { traceId: 'source', runId: 'source', workItemId: `${scope}#1`, profileId: 'fixture', attempt: 1,
      actor: { kind: 'system', id: 'fixture' } }, correlationId: 'source', data: { kind: 'run.finished', outcome: 'succeeded' } }]);
  const audit = { id: 'audit', kind: 'audit' as const, path: events.pathFor('source'), allowedRoot: events.root, runId: 'source' };
  const pack = await buildEvidencePack({ sources: [audit] });
  const file = join(learningDirectory(root), 'candidates.sqlite');
  const store = new CandidateStore({ file });
  stores.push(store);
  const request = store.submitRequest({ request: { version: 1, scope, sourceId: 'import:source', sourceRunId: 'source',
    evidenceDigest: pack.digest, analyzerVersion: 'v1', reason: 'import' }, evidence: pack.entries.map(entry => entry.ref) }, pack);
  const proposal = { ...output.candidates[0], evidenceIds: [pack.entries[0].ref.id], kind: 'tool', targetRef: 'script:fixture', payload: {
    existingTools: ['script:fixture'], inputSchema: { type: 'object', properties: { key: { type: 'string', pattern: '^[a-z]+$' } }, required: ['key'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    dependencies: [], permissions: [], timeoutMs: 500, sideEffects: 'none', idempotency: 'Pure', recovery: 'Retry',
    source: 'console.log(JSON.stringify({value:"new"}));', tests: [
      { kind: 'normal', input: '{"key":"alpha"}', expected: '{"value":"new"}' },
      { kind: 'normal', input: '{"key":"beta"}', expected: '{"value":"new"}' },
      { kind: 'refusal', input: '{"key":"../unsafe"}', expected: 'Refuse' },
    ],
  } };
  const receipt = store.completeRequest(request.key, { version: 1, candidates: [proposal], warnings: [] });
  const candidate = store.getCandidate(receipt.candidateIds[0])!;
  const prepared = prepareAssetProposal(candidate.proposal, inventory);
  const grantFile = join(privateRoot, 'execution.json');
  const entry = { mode: 'repository-asset', scope, checkerId: 'tool-checker', version: 'v1', kind: 'tool',
    executionAuthorizationFile: grantFile, repository: { providerId: 'managed', repository: { url: 'fixture', ref: 'main' }, root: repositoryRoot, expectedCommit },
    asset: { ref: 'script:fixture', path: assetPath }, inventory: { file: inventoryFile, digest: bytesDigest(inventoryBytes) },
    sandbox: { engine: 'docker', baseImageId: `sha256:${'b'.repeat(64)}` },
    semantic: { protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', revision: 'v1', cases: prepared.checks.map(check => {
      const controlled = check.kind === 'cancellation' || check.kind === 'timeout';
      return { checkId: check.id, checkDigest: digest(check), experiment: { protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1',
        kind: check.kind, input: check.input, assertions: [
          { id: 'exit', source: 'exit-code', expected: controlled ? 137 : check.kind === 'refusal' ? 2 : 0 },
          controlled ? { id: 'host', source: 'control', path: ['outcome'], expected: 'triggered' }
            : { id: 'value', source: 'stdout-json', path: ['value'], expected: 'new' },
        ], ...(controlled ? { callInput: '{"key":"alpha"}', control: { kind: check.kind, afterMs: 1 } } : {}) } };
    }) }, evidence: [{ digest: pack.digest, sources: [audit] }],
  };
  const grant = { version: 1, purpose: 'proposal-validation-execution', revoked: false, scope, checkerId: entry.checkerId,
    checkerVersion: entry.version, checkerDigest: digest(entry), kind: entry.kind, repository: entry.repository, asset: entry.asset,
    candidateId: candidate.id, candidateVersion: candidate.version, candidateDigest: candidate.digest, evidenceDigest: candidate.evidenceDigest,
    inventoryDigest: entry.inventory.digest, sandbox: entry.sandbox,
    adapter: { id: entry.semantic.adapter, revision: entry.semantic.revision, hostRuntimeRevision: PROPOSAL_VALIDATION_RUNTIME_REVISION },
    allowed: { dependencies: [], permissions: [], sideEffects: 'none' }, limits: { timeoutMs: 500, maxOutputBytes: 32768 } };
  const configurationFile = join(privateRoot, 'checkers.json');
  const save = () => {
    grant.checkerDigest = digest(entry);
    writeFileSync(configurationFile, JSON.stringify({ version: 2, checkers: [entry] }), { mode: 0o600 });
    writeFileSync(grantFile, JSON.stringify(grant), { mode: 0o600 });
  };
  save();
  const input = { scope, candidateId: candidate.id, expectedVersion: candidate.version, checkerId: entry.checkerId };
  const resolveProvider = vi.fn(async () => undefined);
  const resolveRepository = vi.fn(async () => undefined);
  const options = { file, configurationFile, timeoutMs: 5000, resolveProvider, proposal: { resolveRepository } };
  return { root, store, candidate, request, entry, grant, grantFile, configurationFile, inventoryFile, manifest, audit, save, input, options,
    resolveProvider, resolveRepository, inventory, proposal, pack, assetFile: join(repositoryRoot, assetPath) };
}

function bindScratchHelper(test: Awaited<ReturnType<typeof fixture>>) {
  const bytes = Buffer.alloc(120);
  bytes.set([127, 69, 76, 70, 2, 1, 1]);
  bytes.writeUInt16LE(2, 16);
  bytes.writeUInt16LE(62, 18);
  bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54);
  bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64);
  const path = join(test.root, 'scratch-helper');
  writeFileSync(path, bytes, { mode: 0o500 });
  const binding = { path, digest: bytesDigest(bytes) };
  Object.assign(test.entry.sandbox, { scratchHelper: binding });
  test.save();
  return binding;
}

describe('saved repository-asset production validation routing', () => {
  it('rejects a different candidate with the same checks before reading source evidence or selecting a repository', async () => {
    const test = await fixture();
    const request = test.store.submitRequest({ request: { ...test.request.request, sourceId: 'import:alternate' },
      evidence: test.pack.entries.map(entry => entry.ref) }, test.pack);
    const alternate = { ...test.proposal, payload: { ...test.proposal.payload, source: 'console.log("different body");' } };
    const receipt = test.store.completeRequest(request.key, { version: 1, candidates: [alternate], warnings: [] });
    const candidate = test.store.getCandidate(receipt.candidateIds[0])!;
    const prepared = prepareAssetProposal(candidate.proposal, test.inventory);
    expect(prepared.checks.map(check => digest(check))).toEqual(test.entry.semantic.cases.map(entry => entry.checkDigest));
    expect(candidate.id).not.toBe(test.candidate.id);
    const reconstruct = vi.spyOn(evidence, 'buildEvidencePack');
    expect(await validateConfiguredLearningCandidate({ ...test.input, candidateId: candidate.id, expectedVersion: candidate.version }, test.options))
      .toEqual({ status: 'blocked', code: 'unauthorized' });
    expect(reconstruct).not.toHaveBeenCalled();
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.store.getValidation(candidate.id)).toBeUndefined();
  });

  it.each(['candidateId', 'candidateVersion', 'candidateDigest', 'evidenceDigest'] as const)('rejects drift in the grant %s', async field => {
    const test = await fixture();
    if (field === 'candidateVersion') test.grant[field] += 1;
    else test.grant[field] = 'c'.repeat(64);
    test.save();
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'unauthorized' });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it('requires a new execution grant for host runtime v4', async () => {
    const test = await fixture();
    expect(PROPOSAL_VALIDATION_RUNTIME_REVISION).toBe('proposal-validation-runtime-v4');
    test.grant.adapter.hostRuntimeRevision = 'proposal-validation-runtime-v3';
    test.save();
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'unauthorized' });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it('captures an authorized helper without bypassing unsupported mandatory coverage', async () => {
    const test = await fixture();
    bindScratchHelper(test);
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'insufficient_coverage' });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it('rejects a helper whose bytes differ from the authorized digest before allocation', async () => {
    const test = await fixture();
    const helper = bindScratchHelper(test);
    chmodSync(helper.path, 0o700);
    writeFileSync(helper.path, 'different helper bytes');
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'unauthorized' });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it('rejects helper metadata drift during asynchronous evidence reconstruction', async () => {
    const test = await fixture();
    const helper = bindScratchHelper(test);
    const pack = test.store.getEvidencePack(test.candidate.evidenceDigest)!;
    vi.spyOn(evidence, 'buildEvidencePack').mockImplementationOnce(async () => {
      chmodSync(helper.path, 0o700);
      return pack;
    });
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'source_unavailable' });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it.each(['cancelled', 'timed_out'] as const)('bounds validator module loading after a substituted ready assembly (%s)', async code => {
    const test = await fixture();
    let enter: () => void = () => undefined;
    let release: () => void = () => undefined;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const initialization = new Promise<void>(resolve => { release = resolve; });
    const validator = vi.fn(async () => ({ status: 'blocked', code: 'checker_unavailable' }));
    vi.doMock('./proposal-validation-runtime.js', () => ({
      createConfiguredProposalDependencies: async () => ({ status: 'ready', dependencies: {} }),
    }));
    vi.doMock('./proposal-validation.js', async () => {
      enter();
      await initialization;
      return { validateProposalCandidate: validator };
    });
    const controller = new AbortController();
    const pending = validateConfiguredLearningCandidate(test.input, { ...test.options, signal: controller.signal,
      timeoutMs: code === 'timed_out' ? 240 : 5000 });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered;
      if (code === 'cancelled') controller.abort(null);
      expect(await Promise.race([pending, new Promise(resolve => {
        timer = setTimeout(() => resolve('still_waiting_for_import'), 700);
      })])).toEqual({ status: 'blocked', code });
    } finally {
      release();
      clearTimeout(timer);
      await pending;
    }
    expect(validator).not.toHaveBeenCalled();
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.store.getCandidate(test.candidate.id)).toEqual(test.candidate);
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it.each(['cancelled', 'timed_out'] as const)('bounds pending production evidence assembly (%s)', async code => {
    const test = await fixture();
    const pack = test.store.getEvidencePack(test.candidate.evidenceDigest)!;
    let release: (value: typeof pack) => void = () => undefined;
    let entered: () => void = () => undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const blockedEvidence = new Promise<typeof pack>(resolve => { release = resolve; });
    vi.spyOn(evidence, 'buildEvidencePack').mockImplementationOnce(() => { entered(); return blockedEvidence; });
    const controller = new AbortController();
    const pending = validateConfiguredLearningCandidate(test.input, { ...test.options, signal: controller.signal,
      timeoutMs: code === 'timed_out' ? 200 : 5000 });
    await started;
    if (code === 'cancelled') controller.abort(null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let result: unknown;
    try {
      result = await Promise.race([pending, new Promise(resolve => { timer = setTimeout(() => resolve('still_pending'), 400); })]);
    } finally {
      clearTimeout(timer);
      release(pack);
      await pending;
    }
    expect(result).toEqual({ status: 'blocked', code });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.store.getCandidate(test.candidate.id)).toEqual(test.candidate);
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it('routes a real candidate through its execution grant and catalog, blocking incomplete semantics before execution', async () => {
    const test = await fixture();
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'insufficient_coverage' });
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.store.getCandidate(test.candidate.id)).toEqual(test.candidate);
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it('rejects control input drift without a new independent execution grant', async () => {
    const test = await fixture();
    const configured = test.entry.semantic.cases.find(entry => entry.experiment.kind === 'timeout')!;
    configured.experiment.callInput = '{"key":"beta"}';
    writeFileSync(test.configurationFile, JSON.stringify({ version: 2, checkers: [test.entry] }), { mode: 0o600 });
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'unauthorized' });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it.each([undefined, '{"key":1}', '{"key":"/private"}'])('blocks invalid control business inputs before allocation (%s)', async callInput => {
    const test = await fixture();
    test.entry.semantic.cases.find(entry => entry.experiment.kind === 'timeout')!.experiment.callInput = callInput;
    test.save();
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'insufficient_coverage' });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it.each(['candidate', 'source'] as const)('rechecks %s after asynchronous evidence reconstruction', async change => {
    const test = await fixture();
    const pack = test.store.getEvidencePack(test.candidate.evidenceDigest)!;
    vi.spyOn(evidence, 'buildEvidencePack').mockImplementationOnce(async () => {
      if (change === 'candidate') test.store.transitionCandidate(test.candidate.id, test.candidate.version, 'rejected');
      else test.store.setRequestBlocked(test.request.key, 'source_unstable');
      return pack;
    });
    expect(await validateConfiguredLearningCandidate(test.input, test.options))
      .toEqual({ status: 'blocked', code: change === 'candidate' ? 'stale_candidate' : 'source_unavailable' });
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it('uses the same saved route from the actual plugin system action', async () => {
    const test = await fixture();
    const runtime = new PluginRuntime();
    runtimes.push(runtime);
    await runtime.activate(createLearningPlugin({ homeDir: test.root,
      config: { enabled: true, validation: { configurationFile: test.configurationFile } } }));
    expect(await runtime.dispatchSystemAction('learning.validate', test.input)).toEqual({ status: 'blocked', code: 'insufficient_coverage' });
    expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it.each(['revoked', 'checker', 'repository', 'asset', 'catalog', 'image', 'adapter', 'legacy-host', 'budget'] as const)(
    'rejects a mismatched or revoked execution grant (%s)', async field => {
      const test = await fixture();
      if (field === 'revoked') test.grant.revoked = true;
      if (field === 'checker') test.grant.checkerVersion = 'different';
      if (field === 'repository') test.grant.repository = { ...test.grant.repository, expectedCommit: 'c'.repeat(40) };
      if (field === 'asset') test.grant.asset = { ...test.grant.asset, path: 'script/other.js' };
      if (field === 'catalog') test.grant.inventoryDigest = 'c'.repeat(64);
      if (field === 'image') test.grant.sandbox = { ...test.grant.sandbox, baseImageId: `sha256:${'c'.repeat(64)}` };
      if (field === 'adapter') test.grant.adapter.hostRuntimeRevision = 'different';
      if (field === 'legacy-host') test.grant.adapter.hostRuntimeRevision = 'proposal-validation-runtime-v1';
      if (field === 'budget') test.grant.limits.timeoutMs = 1;
      test.save();
      expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'unauthorized' });
      expect(test.resolveRepository).not.toHaveBeenCalled();
      expect(test.resolveProvider).not.toHaveBeenCalled();
      expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
    },
  );

  it('refuses a Wiki publication grant as execution authorization', async () => {
    const test = await fixture();
    writeFileSync(test.grantFile, JSON.stringify({ version: 1, revoked: false, allowWithdrawal: true, policy: { scope } }));
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'unauthorized' });
    expect(test.resolveProvider).not.toHaveBeenCalled();
  });

  it.each(['source', 'manifest', 'audit', 'permission'] as const)('rejects changed catalog or source inputs (%s)', async field => {
    const test = await fixture();
    if (field === 'source') writeFileSync(test.assetFile, 'changed');
    if (field === 'manifest') writeFileSync(test.inventoryFile, JSON.stringify({ ...test.manifest, toolSearches: ['cli', 'script', 'plugin'] }));
    if (field === 'audit') writeFileSync(test.audit.path, `${readFileSync(test.audit.path, 'utf8')}\n`);
    if (field === 'permission') chmodSync(test.inventoryFile, 0o644);
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'source_unavailable' });
    expect(test.resolveRepository).not.toHaveBeenCalled();
    expect(test.resolveProvider).not.toHaveBeenCalled();
  });

  it('rejects partial experiment coverage without authorizing legacy verification', async () => {
    const test = await fixture();
    test.entry.semantic.cases.pop();
    test.save();
    expect(await validateConfiguredLearningCandidate(test.input, test.options)).toEqual({ status: 'blocked', code: 'insufficient_coverage' });
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.resolveRepository).not.toHaveBeenCalled();
  });

  it('checks candidate scope and version before reading execution configuration', async () => {
    const test = await fixture();
    rmSync(test.configurationFile);
    expect(await validateConfiguredLearningCandidate({ ...test.input, scope: 'github:other/project' }, test.options))
      .toEqual({ status: 'blocked', code: 'scope_mismatch' });
    expect(await validateConfiguredLearningCandidate({ ...test.input, expectedVersion: 2 }, test.options))
      .toEqual({ status: 'blocked', code: 'stale_candidate' });
    expect(test.resolveProvider).not.toHaveBeenCalled();
    expect(test.resolveRepository).not.toHaveBeenCalled();
  });
});
