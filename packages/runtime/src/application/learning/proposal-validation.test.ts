import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateStore } from './candidate-store.js';
import { DISTILLATION_LIMITS, type CandidateProposal } from './contracts.js';
import { buildEvidencePack } from './evidence.js';
import { completeFixtureRequest, output } from './ledger-data.fixture.spec.js';
import { prepareAssetProposal, type ProposalInventory } from './proposals.js';
import { canonicalLearningJson } from './requests.js';
import { PROPOSAL_VALIDATION_RUNTIME_REVISION } from './proposal-validation-runtime.js';
import { readProposalValidationReceipt, type ProposalValidationChecker, type ProposalValidationDependencies } from './proposal-validation.js';
import * as proposalRuntime from './proposal-runtime.js';
import * as proposalSemantics from './proposal-semantics.js';
import { skillTraceArgv } from './skill-trace.js';
import { learningDirectory, queryProposalValidationReceipt } from './worker.js';
import { createLearningPlugin } from '../plugins/learning.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { DockerContainerProvider } from '../../infrastructure/sandbox/container/docker.js';
import { executeFrozenContainer, type FrozenExecutionOptions } from '../../infrastructure/sandbox/container/frozen-execution.js';
import { captureFrozenScratchHelper } from '../../infrastructure/sandbox/container/frozen-input.js';
import { compileScratchFixture } from '../../infrastructure/sandbox/container/frozen-scratch-compiler.fixture.spec.js';
import type { FrozenContainerInspection, FrozenContainerOperations } from '../../infrastructure/sandbox/container/types.js';
import { openSqlite } from '../../infrastructure/storage/sqlite.js';
import type { RepositoryProvider, RepositoryWorkspace } from '../../plugin-sdk/capabilities.js';
import { RepositoryPreparationCleanupError } from '../../infrastructure/providers/repositories.js';

const scope = 'github:acme/api';
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
const bytesDigest = (value: string) => createHash('sha256').update(value).digest('hex');
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });
const blocked = (code: string) => ({ status: 'blocked', code });

async function validate(...args: Parameters<typeof import('./proposal-validation.js')['validateProposalCandidate']>) {
  const modulePath = './proposal-validation.js';
  const implementation = await import(modulePath).catch(() => undefined) as typeof import('./proposal-validation.js') | undefined;
  expect(implementation?.validateProposalCandidate).toBeTypeOf('function');
  return implementation!.validateProposalCandidate(...args);
}

async function fixture(kind: 'skill' | 'tool' = 'tool', existing = true, evidence: 'audit' | 'journal' | 'partial' = 'audit',
  identity: { sourceRunId?: string | null; sourceId?: string; auditRunId?: string; secondAuditRunId?: string; validationRunId?: string; analysisCallId?: string; imported?: boolean } = {},
  frozenSkill = false, pairedTool?: { assetPath: string; baseline: string; proposal: Partial<Extract<CandidateProposal, { kind: 'tool' }>['payload']> }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'proposal-validation-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(learningDirectory(root), 'candidates.sqlite');
  const store = new CandidateStore({ file });
  cleanups.push(() => store.close());
  const events = new JsonlEventStore({ root: join(root, 'events') });
  const auditRunId = identity.auditRunId ?? 'source';
  await events.append([{ id: 'source-event', schemaVersion: 1, type: 'run.finished', occurredAt: '2026-11-12T00:00:00Z',
    context: { traceId: 'source', runId: auditRunId, workItemId: `${scope}#1`, profileId: 'fixture', attempt: 1, actor: { kind: 'system', id: 'fixture' } },
    correlationId: 'source', data: { kind: 'run.finished', outcome: 'succeeded' } }]);
  if (evidence === 'partial') writeFileSync(events.pathFor(auditRunId), `${readFileSync(events.pathFor(auditRunId), 'utf8')}{broken\n`);
  if (evidence === 'journal' && identity.imported) writeFileSync(events.pathFor(auditRunId), JSON.stringify({ content: 'Explicit imported observation without a run identity' }) + '\n');
  if (identity.secondAuditRunId) await events.append([{ id: 'second-source-event', schemaVersion: 1, type: 'run.finished', occurredAt: '2026-11-12T00:00:00Z',
    context: { traceId: 'second-source', runId: identity.secondAuditRunId, workItemId: `${scope}#1`, profileId: 'fixture', attempt: 1, actor: { kind: 'system', id: 'fixture' } },
    correlationId: 'second-source', data: { kind: 'run.finished', outcome: 'succeeded' } }]);
  const pack = await buildEvidencePack({ sources: [{ id: 'audit', kind: evidence === 'journal' ? 'journal' : 'audit',
    path: events.pathFor(auditRunId), allowedRoot: events.root, runId: auditRunId }, ...(identity.secondAuditRunId
    ? [{ id: 'second-audit', kind: 'audit' as const, path: events.pathFor(identity.secondAuditRunId), allowedRoot: events.root, runId: identity.secondAuditRunId }] : [])] });
  const source = store.submitRequest({ request: { version: 1, scope, sourceId: identity.sourceId ?? 'run:source',
    ...(identity.sourceRunId === null ? {} : { sourceRunId: identity.sourceRunId ?? auditRunId }), workItemId: `${scope}#1`,
    analyzerVersion: 'fixture-v1', evidenceDigest: pack.digest, reason: identity.imported ? 'import' : 'completed' }, evidence: pack.entries.map(entry => entry.ref) }, pack);
  const repositoryRoot = join(root, 'repo');
  mkdirSync(repositoryRoot);
  const artifactPath = pairedTool?.assetPath ?? (kind === 'tool' ? 'asset.js' : frozenSkill ? 'recover/SKILL.md' : 'SKILL.md');
  const original = pairedTool?.baseline ?? (kind === 'tool' ? 'console.log("baseline");\n' : `---\nname: recover\ndescription: Recover fixture\ndisable-model-invocation: true\nuser-invocable: ${frozenSkill}\n${frozenSkill ? 'allowed-tools: [Read]\n' : ''}---\nRecover fixture safely.\n`);
  if (pairedTool) {
    mkdirSync(join(repositoryRoot, 'script'));
    for (const directory of ['skills', 'cli', 'plugin']) mkdirSync(join(repositoryRoot, directory));
    writeFileSync(join(repositoryRoot, 'scan-checkpoint.json'), '');
  }
  if (frozenSkill) {
    mkdirSync(join(repositoryRoot, 'recover'));
    writeFileSync(join(repositoryRoot, 'recover/handoff.json'), 'fixture');
  }
  if (existing) writeFileSync(join(repositoryRoot, artifactPath), original);
  writeFileSync(join(repositoryRoot, 'helper.txt'), 'fixed baseline');
  const environment = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
  const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repositoryRoot, ...args],
    { encoding: 'utf8', stdio: 'pipe', env: environment }).trim();
  git('init', '-b', 'main'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'baseline');
  const commit = git('rev-parse', 'HEAD');
  const inventory: ProposalInventory = { skills: kind === 'skill' && existing ? [{ name: 'recover', description: 'Recover fixture',
    'disable-model-invocation': true, 'user-invocable': frozenSkill, 'allowed-tools': frozenSkill ? ['Read'] : [], 'disallowed-tools': [],
    ...(frozenSkill && { resources: [{ path: 'handoff.json', digest: bytesDigest('fixture') }] }),
    source: { root: repositoryRoot, file: join(repositoryRoot, artifactPath) } }] : [],
    toolSearches: ['cli', 'script', 'plugin'], tools: kind === 'tool' && existing ? [{ kind: 'script', ref: 'script:fixture', name: 'fixture',
      description: 'Existing fixture', provenance: 'configured-repository', source: { root: repositoryRoot, file: join(repositoryRoot, artifactPath) } }] : [] };
  const proposal: CandidateProposal = { ...output.candidates[0], title: 'Candidate behavior', evidenceIds: pack.entries.map(entry => entry.ref.id),
    ...(kind === 'tool' ? { kind: 'tool', ...(existing ? { targetRef: 'script:fixture' } : {}), payload: {
      existingTools: existing ? ['script:fixture'] : [], source: 'console.log(JSON.stringify({value:"observed"}));', dependencies: [], permissions: [], timeoutMs: 1000,
      inputSchema: { type: 'object', properties: { key: { type: 'string', pattern: '^[a-z]+$' } }, required: ['key'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
      sideEffects: 'none', idempotency: 'Pure operation', recovery: 'Retry without partial writes', tests: [
        { kind: 'normal', input: '{"key":"alpha"}', expected: '{"value":"candidate-claimed"}' },
        { kind: 'normal', input: '{"key":"beta"}', expected: '{"value":"candidate-claimed"}' },
        { kind: 'refusal', input: '{"key":"../unsafe"}', expected: 'Reject malicious input' },
      ], ...pairedTool?.proposal } } : { kind: 'skill', ...(existing ? { targetRef: 'skill:recover' } : {}), payload: {
      ...(existing ? { targetSkill: 'skill:recover', originalDigest: bytesDigest(original) } : { newReason: 'No matching skill exists' }),
      triggers: ['Explicit recovery request'], prohibitedConditions: ['No permission'], inputs: [{ name: 'target', description: 'Owned target', required: true }],
      branches: ['Verify ownership first'], recovery: ['Stop on refusal'], completion: 'Owned target recovered', patch: 'Bound recovery to the owned target',
      evaluationCases: [{ kind: 'normal', input: 'recover owned', expected: 'candidate claims success' },
        { kind: 'refusal', input: 'recover foreign', expected: 'refuse' }, { kind: 'recovery', input: 'retry interrupted', expected: 'recover' }] } }) };
  const processed = completeFixtureRequest(store, source.key, { version: 1, candidates: [proposal], warnings: [] }, identity.analysisCallId);
  const candidate = store.getCandidate(processed.candidateIds[0])!;
  const prepared = prepareAssetProposal(candidate.proposal, inventory);
  const workspace: RepositoryWorkspace = { id: 'owned-workspace', runId: identity.validationRunId ?? 'independent-validation', repository: { url: 'fixture', ref: 'main' },
    snapshot: { commit, branch: 'main', dirty: false }, path: repositoryRoot };
  const repository: RepositoryProvider = { id: 'fixture-repository', capabilities: { read: true, clone: true, push: false, prepare: true, checkout: true, cleanup: true },
    snapshot: vi.fn(async () => workspace.snapshot), withLifecycleLease: async (_request, operation) => operation(),
    prepare: vi.fn(async () => workspace), checkout: vi.fn(async () => workspace), cleanup: vi.fn(async () => ({ removed: true })) };
  const allocations = new Map<string, { operationId: string; imageId: string; argv: readonly string[]; completed: boolean }>();
  const execution = { stdout: '{"value":"observed"}', code: 0 };
  const engine: FrozenContainerOperations = {
    buildFrozenImage: vi.fn(async operationId => { const imageId = `sha256:${bytesDigest(operationId)}`;
      allocations.set(operationId, { operationId, imageId, argv: [], completed: false }); return imageId; }),
    createFrozenContainer: vi.fn(async (operationId, _imageId, argv) => { allocations.get(operationId)!.argv = argv; return operationId; }),
    inspectFrozenContainer: vi.fn(async containerId => {
      const allocation = allocations.get(containerId)!;
      return { id: containerId, name: `afk-frozen-${allocation.operationId}`, operationId: allocation.operationId, imageId: allocation.imageId,
        status: allocation.completed ? 'exited' : 'created', exitCode: execution.code, user: '1000:1000', readOnlyRoot: true, network: 'none', capDrop: ['ALL'],
        securityOptions: ['no-new-privileges'], privileged: false, pidMode: '', ipcMode: 'private', binds: [], mounts: [],
        tmpfs: { '/scratch': 'rw,noexec,nosuid,nodev,size=16777216,mode=700,uid=1000,gid=1000' }, memory: 268435456,
        memorySwap: 268435456, nanoCpus: 1_000_000_000, pidsLimit: 64, entrypoint: ['/usr/bin/env'],
        command: ['-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'HOME=/scratch', 'TMPDIR=/scratch', ...allocation.argv], workdir: '/workspace' } as FrozenContainerInspection;
    }),
    startFrozenContainer: vi.fn(async containerId => { allocations.get(containerId)!.completed = true; return { code: execution.code, stdout: execution.stdout, stderr: '' }; }),
    cleanupFrozenOperation: vi.fn(async () => {}),
  };
  const provider = new DockerContainerProvider();
  vi.spyOn(provider, 'frozen', 'get').mockReturnValue(engine);
  const checker: ProposalValidationChecker = { id: 'behavior', version: 'oracle-v1', runtimeVersion: 'fixture-runtime-v1', configurationDigest: digest('saved-configuration'),
    target: { scope, ref: workspace.repository.url, revision: commit, snapshotDigest: digest(workspace.snapshot) },
    runtime: { repository, request: { repository: workspace.repository, runId: workspace.runId }, expectedCommit: commit, inventory,
      artifactPath, baseImageId: `sha256:${'a'.repeat(64)}`, sandbox: { executeFrozen: request => executeFrozenContainer(provider, request) },
      harness: { id: 'independent-oracle', revision: 'v1', kind, cases: prepared.checks.map(check => ({ checkId: check.id, checkDigest: digest(check),
        argv: ['node', '/workspace/asset.js'], expected: { value: 'observed' } })),
      observe: vi.fn(async result => ({ status: 'observed' as const, actual: JSON.parse(result.stdout), assertions: 1 })) },
      assertCurrent: vi.fn(async () => {}), recordOwnership: vi.fn(async () => {}) } };
  const stateFile = join(root, 'current.json');
  const current = { authorization: { allowed: true, authorizationDigest: digest('grant-v1') }, source: { current: true, evidenceDigest: pack.digest } };
  const persist = () => writeFileSync(stateFile, JSON.stringify(current));
  persist();
  const dependencies: ProposalValidationDependencies = { store,
    authorize: vi.fn(async () => JSON.parse(readFileSync(stateFile, 'utf8')).authorization),
    reconcile: vi.fn(async () => JSON.parse(readFileSync(stateFile, 'utf8')).source),
    resolveChecker: vi.fn(async () => checker),
    readCommitSnapshot: vi.fn(() => ({ ...JSON.parse(readFileSync(stateFile, 'utf8')), checker })) };
  const input = { scope, candidateId: candidate.id, expectedVersion: candidate.version, checkerId: checker.id };
  const unchanged = () => { expect(store.getCandidate(candidate.id)).toEqual(candidate); expect(store.getValidation(candidate.id)).toBeUndefined(); };
  const rewrite = (kind: string, key: string, change: (value: Record<string, any>) => void) => {
    const database = openSqlite({ file, schema: '', version: 2 });
    try { const row = database.prepare('SELECT payload FROM learning_ledger WHERE kind = ? AND key = ?').get(kind, key)!;
      const value = JSON.parse(String(row.payload)); change(value); const payload = JSON.stringify(value);
      database.prepare('UPDATE learning_ledger SET payload = ?, bytes = ? WHERE kind = ? AND key = ?').run(payload, Buffer.byteLength(payload), kind, key);
    } finally { database.close(); }
  };
  return { root, file, store, source, pack, candidate, prepared, checker, repository, engine, execution, dependencies, input, current, persist, unchanged, rewrite, stateFile };
}

async function recoveryAcceptanceFixture() {
  const test = await fixture();
  const check = test.prepared.checks.find(entry => entry.kind === 'recovery')!;
  const faultInput = '{"key":"partial"}';
  const recoveryInput = '{"key":"saved"}';
  const hex = (value: string) => Buffer.from(value).toString('hex');
  const state = (value: string) => [{ id: 'state', path: 'state.json', bytes: Buffer.from(value).toString('base64') }];
  const returns: NonNullable<proposalSemantics.ProposalSemanticConfiguration['recovery']>['returnAssertions'] = {
    fault: { exitCode: 23, signal: null, stdoutHex: hex('partial\n'), stderrHex: hex('fault\n') },
    recovery: { exitCode: 0, signal: null, stdoutHex: hex('recovered\n'), stderrHex: '' },
    replay: { exitCode: 0, signal: null, stdoutHex: hex('already-ready\n'), stderrHex: '' },
  };
  const configured: proposalSemantics.ProposalSemanticConfiguration = {
    protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', kind: 'recovery', input: check.input, callInput: faultInput,
    assertions: [{ id: 'exit', source: 'exit-code', expected: 0 },
      { id: 'stdout', source: 'stdout', expected: 'partial\nrecovered\nalready-ready\n' },
      { id: 'stderr', source: 'stderr', expected: 'fault\n' }],
    recovery: { contractRevision: 'bounded-recovery-return-state-v1', resources: [{ id: 'state', path: 'state.json' }],
      callInput: recoveryInput, requireEffectHistory: false,
      assertions: { fault: state('partial:saved'), recovered: state('ready:saved'), replayed: state('ready:saved') }, returnAssertions: returns },
  };
  const helperBytes = Buffer.alloc(120);
  Buffer.from([127, 69, 76, 70, 2, 1, 1]).copy(helperBytes);
  helperBytes.writeUInt16LE(2, 16);
  helperBytes.writeUInt16LE(62, 18);
  helperBytes.writeBigUInt64LE(64n, 32);
  helperBytes.writeUInt16LE(56, 54);
  helperBytes.writeUInt16LE(1, 56);
  helperBytes.writeUInt32LE(1, 64);
  const helperPath = join(test.root, 'synthetic-helper.elf');
  writeFileSync(helperPath, helperBytes);
  const helper = captureFrozenScratchHelper(helperPath, createHash('sha256').update(helperBytes).digest('hex'));
  test.checker.runtime.scratchHelper = helper;
  test.checker.runtime.harness!.cases = test.checker.runtime.harness!.cases.map(entry => entry.checkId === check.id
    ? { ...entry, argv: ['node', 'asset.js', faultInput], experiment: configured } : entry);
  const requests: FrozenExecutionOptions[] = [];
  let active: FrozenExecutionOptions;
  const execute = test.checker.runtime.sandbox.executeFrozen;
  test.checker.runtime.sandbox = { limits: { timeoutMs: 750, maxOutputBytes: 8192 }, remainingMs: () => 600,
    executeFrozen: async request => { requests.push(request); active = request; return execute(request); } };
  const start = vi.mocked(test.engine.startFrozenContainer).getMockImplementation()!;
  vi.mocked(test.engine.startFrozenContainer).mockImplementation(async (...args) => {
    const ordinary = await start(...args);
    if (!active.scratch) return ordinary;
    const operationId = args[0];
    const frame = { revision: 'linux-native-scratch-recovery-v1', operationId, inputDigest: active.input.digest,
      helperDigest: helper.digest, artifactDigest: active.input.manifest.find(entry => entry.path === 'asset.js')!.digest,
      candidateVersion: active.scratch.candidateVersion, initialSampledMs: 1,
      initial: [{ id: 'state', path: 'state.json', present: false, hex: null }],
      phases: (['fault', 'recovery', 'replay'] as const).map((phase, index) => ({ phase, ordinal: index + 1,
        invocationId: `${operationId}:${index + 1}`, callInputDigest: bytesDigest(index === 0 ? faultInput : recoveryInput),
        invocation: { pid: index + 7, startedIdentity: String(123 + index), execConfirmed: true, startedMs: index * 3 + 2,
          finishedMs: index * 3 + 3, exitCode: index === 0 ? 23 : 0, signal: null }, sampledMs: index * 3 + 4,
        final: [{ id: 'state', path: 'state.json', present: true, hex: hex(index === 0 ? 'partial:saved' : 'ready:saved') }],
        stdoutHex: returns[phase].stdoutHex, stderrHex: returns[phase].stderrHex })) };
    return { code: 0, stdout: JSON.stringify(frame), stderr: '' };
  });
  return { ...test, check, helper, helperPath, requests };
}

function interceptRecoveryAcceptance(test: Awaited<ReturnType<typeof recoveryAcceptanceFixture>>,
  replace: (observation: proposalRuntime.ProposalRuntimeObservation) => proposalRuntime.ProposalRuntimeObservation,
  beforeFinal: () => void = () => {}) {
  const verify = proposalRuntime.verifyRepositoryAssetProposal;
  const captured: proposalRuntime.ProposalRuntimeObservation[] = [];
  vi.spyOn(proposalRuntime, 'verifyRepositoryAssetProposal').mockImplementation(async (...args) => {
    const result = await verify(...args);
    expect(result.status).toBe('verification-observed');
    if (result.status !== 'verification-observed') return result;
    const comparison = result.comparisons.find(entry => entry.checkId === test.check.id)!;
    for (const version of ['original', 'proposed'] as const) {
      const observation = comparison[version]!;
      captured.push(observation);
      comparison[version] = replace(observation);
    }
    beforeFinal();
    return result;
  });
  return captured;
}

describe('final recovery acceptance with an injected checker and ordinary harness for other checks', () => {
  it('recomputes both recovery versions with the owned context and persists only receipts', async () => {
    const test = await recoveryAcceptanceFixture();
    const observe = vi.spyOn(proposalSemantics, 'observeProposalExperiment');
    const captured = interceptRecoveryAcceptance(test, observation => observation, () => observe.mockClear());
    expect(await validate(test.input, test.dependencies)).toMatchObject({ status: 'validated', validatedVersion: 2 });
    expect(captured.map(observation => observation.receipt.binding.version)).toEqual(['original', 'proposed']);
    expect(observe).toHaveBeenCalledTimes(2);
    for (const [index, observation] of captured.entries()) {
      const context = observation.semanticContext!;
      expect(observe.mock.calls[index][1]).toBe(observation.execution);
      expect(observe.mock.calls[index][2]).toBe(context);
      expect(test.requests).toContain(context.options);
      expect(context.options.scratch!.helper).toBe(test.helper);
      expect(context.options).toMatchObject({ timeoutMs: 600, maxOutputBytes: 8192 });
      expect(context).toMatchObject({ operationId: observation.receipt.binding.operationId, containerId: observation.execution.evidence.containerId });
      expect(observe.mock.results[index].value).toEqual(observation.receipt.semantic);
    }
    const validation = test.store.getValidation(test.candidate.id)!;
    const savedJson = Buffer.from(validation.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString();
    const saved = JSON.parse(savedJson);
    expect(saved.receiptDigest).toBe(digest(saved.report));
    const comparison = saved.report.comparisons.find((entry: { checkId: string }) => entry.checkId === test.check.id);
    for (const version of ['original', 'proposed'] as const) {
      const packed = comparison[version];
      expect(Object.keys(packed).sort()).toEqual(['receipt', 'receiptDigest']);
      expect(packed.receipt.semantic.passed).toBe(true);
      expect(packed.receipt).not.toHaveProperty('actual');
      expect(digest({ ...packed.receipt, actual: packed.receipt.semantic.assertions, expected: comparison.expected,
        binding: { ...saved.report.observationBinding, ...comparison.binding, ...packed.receipt.binding } })).toBe(packed.receiptDigest);
    }
    for (const field of ['semanticContext', 'scratchHelper', 'helper', 'options']) expect(savedJson).not.toContain(`"${field}":`);
    expect(savedJson).not.toContain(test.helperPath);
  });

  it.each(['missing-context', 'operation', 'container', 'helper', 'timeout-limit', 'output-limit', 'saved-timeout', 'output', 'semantic-receipt'] as const)(
    'rejects %s tampering after real runtime observation and before final acceptance', async mode => {
      const test = await recoveryAcceptanceFixture();
      const persist = vi.spyOn(test.store, 'recordValidation');
      const captured = interceptRecoveryAcceptance(test, observation => {
        if (observation.receipt.binding.version !== 'proposed') return observation;
        const context = observation.semanticContext!;
        const changed = { ...observation, semanticContext: { ...context, options: { ...context.options } },
          receipt: { ...observation.receipt, binding: { ...observation.receipt.binding } } };
        if (mode === 'missing-context') return { ...changed, semanticContext: undefined };
        if (mode === 'operation') changed.semanticContext.operationId = 'foreign-operation';
        if (mode === 'container') changed.semanticContext.containerId = 'f'.repeat(64);
        if (mode === 'helper') changed.semanticContext.options.scratch = { ...context.options.scratch!, helper: { ...test.helper } };
        if (mode === 'timeout-limit') changed.semanticContext.options.timeoutMs = 751;
        if (mode === 'output-limit') changed.semanticContext.options.maxOutputBytes = 8193;
        if (mode === 'saved-timeout') changed.semanticContext.options.timeoutMs = context.options.timeoutMs + 1;
        if (mode === 'output') {
          changed.execution = { ...observation.execution, stdout: `${observation.execution.stdout}forged` };
          changed.receipt.binding.executionDigest = digest(changed.execution);
        }
        if (mode === 'semantic-receipt') {
          const semantic = observation.receipt.semantic!;
          changed.receipt.semantic = { ...semantic, assertions: semantic.assertions.map(assertion => ({ ...assertion, actual: 'forged' })) };
          changed.receipt.actual = changed.receipt.semantic.assertions;
        }
        changed.receiptDigest = digest(changed.receipt);
        return changed;
      });
      const result = await validate(test.input, test.dependencies);
      const code = ['semantic-receipt', 'saved-timeout', 'output'].includes(mode) ? 'invalid_receipt' : 'binding_mismatch';
      expect(result).toEqual(blocked(code));
      expect(captured).toHaveLength(2);
      expect(captured.every(observation => observation.receipt.semantic?.passed)).toBe(true);
      expect(persist).not.toHaveBeenCalled();
      expect(test.repository.cleanup).toHaveBeenCalledOnce();
      test.unchanged();
    });
});

describe('shared proposal candidate validation foundation', () => {
  it('reports allocation cleanup failure as storage failure without exposing paths or promoting the candidate', async () => {
    const test = await fixture();
    const recovery = new RepositoryPreparationCleanupError({ id: 'retained', runId: 'independent-validation',
      repository: { url: 'fixture', ref: 'main' }, path: '/private/retained-workspace' }, new Error('snapshot'), new Error('cleanup'));
    vi.mocked(test.repository.prepare!).mockRejectedValue(recovery);
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('storage_failed'));
    test.unchanged();
    expect(test.engine.startFrozenContainer).not.toHaveBeenCalled();
  });

  it.each(['tool', 'skill'] as const)('validates a real %s candidate only after frozen execution, independent oracle and cleanup', async kind => {
    const test = await fixture(kind);
    const result = await validate(test.input, test.dependencies);
    expect(result).toMatchObject({ status: 'validated', candidateId: test.candidate.id, candidateVersion: 1, validatedVersion: 2 });
    expect(test.engine.startFrozenContainer).toHaveBeenCalledTimes(test.prepared.checks.length * 2);
    expect(test.checker.runtime.recordOwnership).toHaveBeenCalledTimes(test.prepared.checks.length * 2);
    expect(test.repository.cleanup).toHaveBeenCalledOnce();
    const receipt = test.store.getValidation(test.candidate.id)!;
    expect(receipt.passed).toBe(true);
    const saved = JSON.parse(Buffer.from(receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString());
    expect(saved.receiptDigest).toBe(digest(saved.report));
    expect(saved.report.binding).toMatchObject({ candidateId: test.candidate.id, candidateDigest: test.candidate.digest,
      evidenceDigest: test.pack.digest, checkerId: 'behavior', checkerVersion: 'oracle-v1', runtimeVersion: 'fixture-runtime-v1', configurationDigest: test.checker.configurationDigest,
      authorizationDigest: test.current.authorization.authorizationDigest });
    expect(saved.report.comparisons).toHaveLength(test.prepared.checks.length);
    for (const comparison of saved.report.comparisons) for (const observation of [comparison.original, comparison.proposed].filter(Boolean)) {
      expect(digest({ ...observation.receipt, expected: comparison.expected,
        binding: { ...saved.report.observationBinding, ...comparison.binding, ...observation.receipt.binding } })).toBe(observation.receiptDigest);
    }
    const reopened = new CandidateStore({ file: test.file });
    try {
      const candidate = reopened.getCandidate(test.candidate.id)!;
      expect(candidate.state).toBe('validated');
      expect(reopened.getValidation(test.candidate.id)).toEqual(receipt);
      if (result.status !== 'validated') throw new Error('Expected a validated fixture');
      const projection = {
        candidateId: result.candidateId, candidateVersion: result.candidateVersion, validatedVersion: result.validatedVersion,
        executionId: result.executionId, receiptDigest: result.receiptDigest, kind, scope,
        candidateDigest: candidate.digest, evidenceDigest: test.pack.digest,
        checkerId: test.checker.id, repositoryDigest: digest(test.checker.runtime.request.repository), commit: test.checker.runtime.expectedCommit,
        artifactPath: test.checker.runtime.artifactPath, artifactDigest: test.prepared.artifact.digest,
        originalArtifactDigest: test.prepared.artifact.originalDigest,
      };
      const target = { directory: learningDirectory(test.root), scope, candidateId: candidate.id };
      expect(queryProposalValidationReceipt(target)).toEqual(projection);
      expect(queryProposalValidationReceipt({ ...target, scope: 'github:other/api' })).toBeNull();
      const missing = join(test.root, 'missing');
      expect(queryProposalValidationReceipt({ ...target, directory: missing })).toBeNull();
      expect(existsSync(missing)).toBe(false);
      const corrupted = Buffer.from(JSON.stringify({ ...saved, receiptDigest: '0'.repeat(64) })).toString('base64');
      expect(readProposalValidationReceipt(candidate, { ...receipt,
        results: corrupted.match(/.{1,1800}/g)!.map(chunk => `json-base64-v1:${chunk}`) })).toBeNull();
      expect(readProposalValidationReceipt({ ...candidate, state: 'revoked' }, receipt)).toBeNull();
      const database = openSqlite({ file: test.file, schema: '', version: 2 });
      try {
        const payload = JSON.stringify({ ...receipt, results: ['json-base64-v1:e2JhZA=='] });
        database.prepare("UPDATE learning_ledger SET payload = ?, bytes = ? WHERE kind = 'validation'")
          .run(payload, Buffer.byteLength(payload));
      } finally { database.close(); }
      expect(queryProposalValidationReceipt(target)).toBeNull();
    }
    finally { reopened.close(); }
  });

  it.each(['improved', 'tie', 'missing', 'regressed'] as const)('checks paired frozen skill receipts before recording %s', async outcome => {
    const test = await fixture('skill', true, 'audit', {}, true);
    const { runtime } = test.checker;
    const checkerDigest = bytesDigest('frozen observer');
    const resource = { path: '/business/handoff.json', digest: bytesDigest('fixture') };
    runtime.harness!.cases = test.prepared.checks.map(check => ({ checkId: check.id, checkDigest: digest(check), expected: 'business',
      argv: skillTraceArgv(runtime.artifactPath, check.input, checkerDigest), experiment: { protocol: 'proposal-semantic-v1', adapter: 'skill-trace-v1',
        kind: check.kind, input: check.input, skillTrace: { checkerDigest, reads: check.kind === 'normal' ? [resource] : [] },
        assertions: [{ id: 'exit', source: 'exit-code', expected: check.kind === 'refusal' ? 1 : 0 }, { id: 'answer', source: 'stdout', expected: 'business' }] } }));
    let active: FrozenExecutionOptions;
    const execute = runtime.sandbox.executeFrozen;
    runtime.sandbox = { executeFrozen: request => { active = request; return execute(request); } };
    const start = vi.mocked(test.engine.startFrozenContainer).getMockImplementation()!;
    vi.mocked(test.engine.startFrozenContainer).mockImplementation(async (...args) => {
      const check = test.prepared.checks.find(entry => entry.input === active.argv.at(-2))!;
      const artifactDigest = active.input.manifest.find(entry => entry.path === runtime.artifactPath)!.digest;
      const baseline = artifactDigest === test.prepared.artifact.originalDigest;
      const invalid = check.kind === 'normal' && (baseline ? outcome === 'improved' : outcome === 'regressed');
      test.execution.code = invalid ? 2 : check.kind === 'refusal' ? 1 : 0;
      test.execution.stdout = invalid ? 'unparseable answer' : 'business';
      const result = await start(...args);
      return { ...result, stderr: baseline && outcome === 'missing' ? '' : JSON.stringify({ protocol: 'skill-trace-v1', completed: true,
        inputDigest: bytesDigest(check.input), outputDigest: bytesDigest(result.stdout), businessValid: !invalid,
        loaded: { path: `/workspace/${runtime.artifactPath}`, digest: artifactDigest }, calls: check.kind === 'normal' ? [{ tool: 'Read', result: resource }] : [] }) };
    });
    const result = await validate(test.input, test.dependencies);
    if (outcome === 'improved') expect(result).toMatchObject({ status: 'validated', validatedVersion: 2 });
    else {
      expect(result).toEqual(blocked(outcome === 'missing' ? 'verification_failed' : 'assertion_failed'));
      test.unchanged();
    }
  });

  it.each(['run:source', 'import:unrelated-name'] as const)('rejects provenance source run reuse with absent optional sourceRunId and sourceId %s', async sourceId => {
    const test = await fixture('tool', true, 'audit', { sourceRunId: null, sourceId, validationRunId: 'source', imported: true });
    expect(test.source.request.sourceRunId).toBeUndefined();
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('target_mismatch'));
    expect(test.repository.prepare).not.toHaveBeenCalled(); test.unchanged();
  });

  it('rejects request sourceRunId that contradicts trusted audit provenance', async () => {
    const test = await fixture('tool', true, 'audit', { sourceRunId: 'claimed-independent-source', validationRunId: 'source' });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('source_unavailable'));
    expect(test.repository.prepare).not.toHaveBeenCalled(); test.unchanged();
  });

  it('rejects reuse of every contributing audit run, including secondary provenance', async () => {
    const test = await fixture('tool', true, 'audit', { secondAuditRunId: 'second-source', validationRunId: 'second-source' });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('target_mismatch'));
    expect(test.repository.prepare).not.toHaveBeenCalled(); test.unchanged();
  });

  it('blocks an imported pack whose observed run identity has been redacted', async () => {
    const test = await fixture('tool', true, 'audit', { sourceRunId: null, auditRunId: '[redacted]', imported: true });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('source_unavailable'));
    expect(test.repository.prepare).not.toHaveBeenCalled(); test.unchanged();
  });

  it('keeps explicit declared imports valid in the store but blocked for proposal validation', async () => {
    const test = await fixture('tool', true, 'journal', { sourceRunId: null, imported: true });
    expect(test.source.request.reason).toBe('import');
    expect(JSON.parse(test.pack.entries[0].content).context).toBeUndefined();
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('insufficient_evidence'));
    expect(test.repository.prepare).not.toHaveBeenCalled(); test.unchanged();
  });

  it('validates an independent explicit import from observed provenance without inventing request run metadata', async () => {
    const test = await fixture('tool', true, 'audit', { sourceRunId: null, sourceId: 'import:opaque-reference', imported: true, secondAuditRunId: 'second-source' });
    const record = test.store.recordValidation.bind(test.store);
    const read = test.store.getEvidencePack.bind(test.store);
    let insideCommit = false;
    let transactionReads = 0;
    vi.spyOn(test.store, 'getEvidencePack').mockImplementation((...args) => {
      if (insideCommit) transactionReads++;
      return read(...args);
    });
    vi.spyOn(test.store, 'recordValidation').mockImplementation((candidateId, version, receipt, guard) => record(candidateId, version, receipt, () => {
      insideCommit = true;
      try { guard!(); } finally { insideCommit = false; }
    }));
    expect(await validate(test.input, test.dependencies)).toMatchObject({ status: 'validated' });
    expect(transactionReads).toBeGreaterThan(0);
    expect(test.store.getRequest(test.source.key)?.request.sourceRunId).toBeUndefined();
    const receipt = test.store.getValidation(test.candidate.id)!;
    const saved = JSON.parse(Buffer.from(receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString());
    expect(saved.report.binding.sourceRunIds).toEqual(['second-source', 'source']);
  });

  it.each([{ passed: true }, { command: ['sh', '-c', 'client command'] }, { expected: 'success' }, { checkerVersion: 'client-v1' }])('rejects client authority %# before resolving a checker', async extra => {
    const test = await fixture();
    expect(await validate({ ...test.input, ...extra }, test.dependencies)).toEqual(blocked('invalid_input'));
    expect(test.dependencies.resolveChecker).not.toHaveBeenCalled(); test.unchanged();
  });

  it.each(['inherited', 'accessor'] as const)('rejects %s client fields without invoking getters', async mode => {
    const test = await fixture();
    const getter = vi.fn(() => test.input.candidateId);
    const input = mode === 'inherited' ? Object.assign(Object.create({ candidateId: test.input.candidateId }), test.input) : { ...test.input };
    if (mode === 'inherited') delete input.candidateId;
    else Object.defineProperty(input, 'candidateId', { enumerable: true, get: getter });
    expect(await validate(input, test.dependencies)).toEqual(blocked('invalid_input'));
    expect(getter).not.toHaveBeenCalled(); expect(test.dependencies.resolveChecker).not.toHaveBeenCalled(); test.unchanged();
  });

  it('rechecks validation run independence in the final transaction', async () => {
    const test = await fixture('tool', true, 'audit', { analysisCallId: 'analysis-fixture' });
    const record = test.store.recordValidation.bind(test.store);
    vi.spyOn(test.store, 'recordValidation').mockImplementation((...args) => {
      test.store.recordAnalysisIdentity('analysis-fixture', { analysisRunId: 'independent-analysis', sessionId: test.checker.runtime.request.runId });
      return record(...args);
    });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('target_mismatch')); test.unchanged();
  });

  it.each(['source', 'grant', 'configuration', 'target', 'runtime', 'runtime-version', 'sandbox-limits', 'remaining-budget', 'scratch-helper'] as const)('rechecks %s at the final synchronous commit boundary', async mode => {
    const test = await fixture();
    const record = test.store.recordValidation.bind(test.store);
    vi.spyOn(test.store, 'recordValidation').mockImplementation((...args) => {
      if (mode === 'source') { test.current.source.current = false; test.persist(); }
      if (mode === 'grant') { test.current.authorization.authorizationDigest = digest('replacement-grant'); test.persist(); }
      if (mode === 'configuration') test.checker.configurationDigest = digest('replacement-config');
      if (mode === 'target') test.checker.target.snapshotDigest = digest('replacement-target');
      if (mode === 'runtime') test.checker.runtime.sandbox.executeFrozen = async () => { throw new Error('replacement-runtime'); };
      if (mode === 'runtime-version') test.checker.runtimeVersion = 'fixture-runtime-v2';
      if (mode === 'sandbox-limits') test.checker.runtime.sandbox.limits = { timeoutMs: 1, maxOutputBytes: 1 };
      if (mode === 'remaining-budget') test.checker.runtime.sandbox.remainingMs = () => 1;
      if (mode === 'scratch-helper') test.checker.runtime.scratchHelper = { digest: 'a'.repeat(64), architecture: 'x64' };
      return record(...args);
    });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked(mode === 'source' ? 'source_unavailable' : mode === 'grant'
      ? 'authorization_changed' : mode === 'target' ? 'target_mismatch' : 'checker_changed')); test.unchanged();
  });

  it('preserves saved sandbox limits and the remaining budget through final validation', async () => {
    const test = await fixture();
    test.checker.runtime.sandbox.limits = { timeoutMs: 950, maxOutputBytes: 128 };
    test.checker.runtime.sandbox.remainingMs = () => 800.9;
    const execute = test.checker.runtime.sandbox.executeFrozen;
    const requests = vi.fn(async (request: Parameters<typeof execute>[0]) => {
      expect(request.timeoutMs).toBe(800);
      expect(request.maxOutputBytes).toBe(128);
      return execute(request);
    });
    test.checker.runtime.sandbox.executeFrozen = requests;
    expect(await validate(test.input, test.dependencies)).toMatchObject({ status: 'validated' });
    expect(requests).toHaveBeenCalledTimes(test.prepared.checks.length * 2);
  });

  it('accepts an own-data null-prototype DTO and a tool with no original baseline', async () => {
    const test = await fixture('tool', false);
    expect(await validate(Object.assign(Object.create(null), test.input), test.dependencies)).toMatchObject({ status: 'validated' });
    expect(test.engine.startFrozenContainer).toHaveBeenCalledTimes(test.prepared.checks.length);
    const validation = test.store.getValidation(test.candidate.id)!;
    const saved = JSON.parse(Buffer.from(validation.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString());
    expect(saved.report.comparisons.every((comparison: { original?: unknown }) => comparison.original === undefined)).toBe(true);
    expect(readProposalValidationReceipt(test.store.getCandidate(test.candidate.id)!, validation)).toMatchObject({ originalArtifactDigest: null });
  });

  it('permits original failures only when every proposed oracle passes', async () => {
    const test = await fixture();
    const start = test.engine.startFrozenContainer;
    let count = 0;
    test.engine.startFrozenContainer = async (...args) => {
      const result = await start(...args);
      return { ...result, stdout: JSON.stringify({ value: count++ % 2 === 0 ? 'original-fails' : 'observed' }) };
    };
    expect(await validate(test.input, test.dependencies)).toMatchObject({ status: 'validated' });
    const validation = test.store.getValidation(test.candidate.id)!;
    const saved = JSON.parse(Buffer.from(validation.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString());
    expect(saved.report.comparisons.every((comparison: { original: { receipt: { passed: boolean } }; proposed: { receipt: { passed: boolean } } }) =>
      !comparison.original.receipt.passed && comparison.proposed.receipt.passed)).toBe(true);
  });

  it.each(['unauthorized', 'pre-aborted', 'checker', 'timeout', 'candidate', 'source-run', 'analysis-run'] as const)('rejects initial %s without allocating a workspace', async mode => {
    const test = await fixture('tool', true, 'audit', { analysisCallId: mode === 'analysis-run' ? 'analysis-fixture' : undefined });
    const controller = new AbortController();
    if (mode === 'unauthorized') { test.current.authorization.allowed = false; test.persist(); }
    if (mode === 'pre-aborted') controller.abort();
    if (mode === 'checker') vi.mocked(test.dependencies.resolveChecker).mockResolvedValue(undefined);
    if (mode === 'candidate') test.input.candidateId = 'f'.repeat(64);
    if (mode === 'source-run') test.checker.runtime.request = { ...test.checker.runtime.request, runId: 'source' };
    if (mode === 'analysis-run') {
      test.store.recordAnalysisIdentity('analysis-fixture', { analysisRunId: test.checker.runtime.request.runId, sessionId: 'analysis-session' });
    }
    const codes = { unauthorized: 'unauthorized', 'pre-aborted': 'cancelled', checker: 'checker_unavailable', timeout: 'invalid_input',
      candidate: 'candidate_unavailable', 'source-run': 'target_mismatch', 'analysis-run': 'target_mismatch' };
    expect(await validate(test.input, test.dependencies, { signal: controller.signal, timeoutMs: mode === 'timeout' ? 0 : 5000 })).toEqual(blocked(codes[mode]));
    expect(test.repository.prepare).not.toHaveBeenCalled(); test.unchanged();
  });

  it.each(['mechanism', 'ownership', 'cleanup', 'assertions'] as const)('rejects forged frozen %s evidence', async mode => {
    const test = await fixture();
    const execute = test.checker.runtime.sandbox.executeFrozen;
    test.checker.runtime.sandbox.executeFrozen = async request => {
      const result = await execute(request);
      if (mode === 'mechanism') return { ...result, evidence: { ...result.evidence, mechanism: 'exit-zero' as typeof result.evidence.mechanism } };
      if (mode === 'ownership') return { ...result, evidence: { ...result.evidence, operationId: 'foreign-operation' } };
      if (mode === 'cleanup') return { ...result, cleanup: { ...result.cleanup, containerRemoved: false } } as unknown as typeof result;
      return result;
    };
    if (mode === 'assertions') test.checker.runtime.harness!.observe = async () => ({ status: 'observed', actual: { value: 'observed' }, assertions: 0 });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('verification_failed')); test.unchanged();
  });

  it.each(['scope', 'version', 'state', 'kind', 'digest', 'source', 'evidence'] as const)('rejects invalid stored/input %s before allocation', async mode => {
    const test = await fixture();
    const codes = { scope: 'scope_mismatch', version: 'stale_candidate', state: 'stale_candidate', kind: 'unsupported_kind',
      digest: 'insufficient_evidence', source: 'source_unavailable', evidence: 'evidence_unavailable' };
    if (mode === 'scope') test.input.scope = 'github:foreign/repo';
    if (mode === 'version') test.input.expectedVersion++;
    if (mode === 'state') test.store.transitionCandidate(test.candidate.id, 1, 'rejected');
    if (mode === 'kind') test.rewrite('candidate', test.candidate.id, value => { value.proposal = output.candidates[0]; value.digest = digest(value.proposal); });
    if (mode === 'digest') test.rewrite('candidate', test.candidate.id, value => { value.digest = 'f'.repeat(64); });
    if (mode === 'source') test.store.setRequestBlocked(test.source.key, 'source_unstable');
    if (mode === 'evidence') { const database = openSqlite({ file: test.file, schema: '', version: 2 }); database.prepare('DELETE FROM learning_ledger WHERE kind = ?').run('snapshot'); database.close(); }
    expect(await validate(test.input, test.dependencies)).toEqual(blocked(codes[mode]));
    expect(test.repository.prepare).not.toHaveBeenCalled(); expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it.each(['journal', 'partial'] as const)('rejects genuine %s evidence without executing a proposal', async evidence => {
    const test = await fixture('tool', true, evidence);
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('insufficient_evidence'));
    expect(test.repository.prepare).not.toHaveBeenCalled(); test.unchanged();
  });

  it.each(['request-scope', 'request-digest', 'evidence-digest', 'candidate-evidence', 'processing'] as const)('rejects corrupted %s linkage in the real store', async mode => {
    const test = await fixture();
    if (mode === 'request-scope') test.rewrite('request', test.source.key, value => { value.request.scope = 'github:foreign/repo'; });
    if (mode === 'request-digest') test.rewrite('request', test.source.key, value => { value.request.analyzerVersion = 'tampered-version'; });
    if (mode === 'evidence-digest') test.rewrite('snapshot', test.pack.digest, value => { value.digest = 'f'.repeat(64); });
    if (mode === 'candidate-evidence') test.rewrite('candidate', test.candidate.id, value => { value.evidenceDigest = 'f'.repeat(64); });
    if (mode === 'processing') test.rewrite('processing', test.source.key, value => { value.candidateIds = []; });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked(mode === 'request-scope' ? 'scope_mismatch'
      : mode === 'evidence-digest' ? 'storage_failed' : 'source_unavailable'));
    expect(test.repository.prepare).not.toHaveBeenCalled(); expect(test.store.getValidation(test.candidate.id)).toBeUndefined();
  });

  it('detects inventory source bytes replaced immediately before commit', async () => {
    const test = await fixture();
    const record = test.store.recordValidation.bind(test.store);
    vi.spyOn(test.store, 'recordValidation').mockImplementation((...args) => {
      writeFileSync(test.checker.runtime.inventory.tools[0].source!.file, 'replacement source');
      return record(...args);
    });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('target_mismatch')); test.unchanged();
  });

  it.each(['failed', 'unsupported', 'missing', 'coverage', 'exit'] as const)('refuses %s oracle results and never uses candidate expected as authority', async mode => {
    const test = await fixture();
    if (mode === 'failed') test.execution.stdout = '{"value":"candidate-claimed"}';
    if (mode === 'exit') test.execution.code = 1;
    if (mode === 'unsupported') test.checker.runtime.harness!.observe = async () => ({ status: 'unsupported', reason: 'behavior_not_supported' });
    if (mode === 'missing') test.checker.runtime.harness = undefined;
    if (mode === 'coverage') test.checker.runtime.harness!.cases.pop();
    expect(await validate(test.input, test.dependencies)).toEqual(blocked(mode === 'missing' || mode === 'coverage' ? 'checker_unavailable' : mode === 'unsupported' ? 'insufficient_coverage' : 'assertion_failed'));
    test.unchanged();
  });

  it.each(['source', 'grant', 'configuration', 'target', 'runtime', 'checker'] as const)('rejects %s drift during execution', async mode => {
    const test = await fixture();
    const observe = test.checker.runtime.harness!.observe;
    test.checker.runtime.harness!.observe = async (...args) => {
      const result = await observe(...args);
      if (mode === 'source') { test.current.source.current = false; test.persist(); }
      if (mode === 'grant') { test.current.authorization.allowed = false; test.persist(); }
      if (mode === 'configuration') test.checker.configurationDigest = digest('changed');
      if (mode === 'target') test.checker.target.snapshotDigest = digest('changed');
      if (mode === 'runtime') test.checker.runtime.sandbox.executeFrozen = async () => { throw new Error('changed runtime'); };
      if (mode === 'checker') test.checker.version = 'oracle-v2';
      return result;
    };
    expect(await validate(test.input, test.dependencies)).toEqual(blocked({ source: 'source_unavailable', grant: 'unauthorized',
      configuration: 'checker_changed', target: 'target_mismatch', runtime: 'checker_changed', checker: 'checker_changed' }[mode]));
    expect(test.repository.cleanup).toHaveBeenCalledOnce(); test.unchanged();
  });

  it.each(['repository', 'engine', 'lease', 'capacity'] as const)('does not validate after %s resource failure', async mode => {
    const test = await fixture();
    if (mode === 'repository') vi.mocked(test.repository.cleanup!).mockRejectedValue(new Error('cleanup failed'));
    if (mode === 'engine') vi.mocked(test.engine.cleanupFrozenOperation).mockRejectedValue(new Error('engine cleanup failed'));
    if (mode === 'lease') test.repository.withLifecycleLease = async (_request, operation) => { await operation(); throw new Error('lease release failed'); };
    if (mode === 'capacity') vi.spyOn(test.store, 'recordValidation').mockImplementation(() => { throw new Error('capacity reached'); });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('storage_failed')); test.unchanged();
  });

  it.each(['cancel', 'deadline'] as const)('waits for repository cleanup after %s without allowing a late oracle to commit', async mode => {
    const test = await fixture();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const active = new Promise<void>(resolve => { entered = resolve; });
    test.checker.runtime.harness!.observe = async () => { entered!(); await new Promise<void>(resolve => { release = resolve; });
      return { status: 'observed', actual: { value: 'observed' }, assertions: 1 }; };
    let startedCleanup!: () => void;
    let finishCleanup!: () => void;
    const cleaning = new Promise<void>(resolve => { startedCleanup = resolve; });
    const cleanupGate = new Promise<void>(resolve => { finishCleanup = resolve; });
    vi.mocked(test.repository.cleanup!).mockImplementation(async () => {
      startedCleanup();
      await cleanupGate;
      return { removed: true };
    });
    const recording = validate(test.input, test.dependencies, { signal: controller.signal, timeoutMs: mode === 'deadline' ? 1000 : 5000 });
    await active;
    if (mode === 'cancel') controller.abort();
    try {
      expect(await Promise.race([recording.then(() => 'returned'), cleaning.then(() => 'cleaning')])).toBe('cleaning');
      expect(await Promise.race([recording.then(() => 'returned'), new Promise(resolve => setImmediate(() => resolve('pending')))])).toBe('pending');
    }
    finally { release!(); finishCleanup(); }
    expect(await recording).toEqual(blocked(mode === 'deadline' ? 'timed_out' : 'cancelled'));
    test.unchanged();
  });

  it('uses real CAS to let only one simultaneous validation commit', async () => {
    const test = await fixture();
    const second = new CandidateStore({ file: test.file }); cleanups.push(() => second.close());
    const results = await Promise.all([validate(test.input, test.dependencies), validate(test.input, { ...test.dependencies, store: second })]);
    expect(results.filter(result => result.status === 'validated')).toHaveLength(1);
    expect(results.filter(result => result.status === 'blocked')).toEqual([blocked('stale_candidate')]);
    expect(test.store.getCandidateVersions(test.candidate.id)).toHaveLength(2);
  });

  it.each(['resolved', 'rejected'] as const)('rejects a %s Promise final snapshot from inside the actual recordValidation transaction', async mode => {
    const test = await fixture();
    const record = test.store.recordValidation.bind(test.store);
    vi.spyOn(test.store, 'recordValidation').mockImplementation((...args) => {
      test.dependencies.readCommitSnapshot = (() => mode === 'resolved' ? Promise.resolve({ checker: test.checker })
        : Promise.reject(new Error('asynchronous final guard'))) as unknown as ProposalValidationDependencies['readCommitSnapshot'];
      return record(...args);
    });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('commit_guard_unavailable')); test.unchanged();
  });

  it.each(['revocation', 'deadline'] as const)('rechecks %s after waiting for a real SQLite writer lock', async mode => {
    const test = await fixture();
    const coordination = new SharedArrayBuffer(8);
    const state = new Int32Array(coordination);
    const timeoutMs = mode === 'deadline' ? 20_000 : 5000;
    if (mode === 'deadline') {
      const now = performance.now.bind(performance);
      vi.spyOn(performance, 'now').mockImplementation(() => now() + (Atomics.load(state, 1) === 2 ? timeoutMs : 0));
    }
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs');
      const database = new DatabaseSync(workerData.file); const state = new Int32Array(workerData.coordination);
      parentPort.postMessage('ready'); Atomics.wait(state, 0, 0); database.exec('BEGIN IMMEDIATE');
      Atomics.store(state, 1, 1); Atomics.notify(state, 1);
      Atomics.wait(state, 0, 1); Atomics.wait(state, 0, 2, 150);
      if (workerData.revoke) { const value = JSON.parse(fs.readFileSync(workerData.stateFile)); value.authorization.allowed = false; fs.writeFileSync(workerData.stateFile, JSON.stringify(value)); }
      Atomics.store(state, 1, 2); database.exec('COMMIT'); database.close();`, { eval: true, workerData: { file: test.file, coordination, stateFile: test.stateFile, revoke: mode === 'revocation' } });
    cleanups.push(() => { void worker.terminate(); });
    await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
    const record = test.store.recordValidation.bind(test.store);
    const commitGuardWriterStates: number[] = [];
    vi.spyOn(test.store, 'recordValidation').mockImplementation((candidateId, version, receipt, guard) => {
      Atomics.store(state, 0, 1); Atomics.notify(state, 0);
      expect(Atomics.wait(state, 1, 0, 5000)).not.toBe('timed-out');
      Atomics.store(state, 0, 2); Atomics.notify(state, 0);
      return record(candidateId, version, receipt, () => {
        commitGuardWriterStates.push(Atomics.load(state, 1));
        guard?.();
      });
    });
    expect(await validate(test.input, test.dependencies, { timeoutMs })).toEqual(blocked(mode === 'deadline' ? 'timed_out' : 'unauthorized'));
    expect(test.store.recordValidation).toHaveBeenCalledOnce();
    expect(commitGuardWriterStates).toEqual([2]);
    test.unchanged();
  });
});

describe.runIf(process.env.AFK_TEST_FROZEN_DOCKER === '1')('candidate use case with the local Docker engine', () => {
  it.runIf(Boolean(process.env.AFK_TEST_W06_BUNDLE))('qualifies eight paired scan cases through the candidate ledger', async () => {
    const bundle = process.env.AFK_TEST_W06_BUNDLE!;
    const read = (name: string) => readFileSync(join(bundle, name), 'utf8');
    const manifest = JSON.parse(read('receipt.json')) as { assetPath: string; cases: Array<{ checkId: string; experiment: unknown }> };
    const cases = manifest.cases.map(entry => ({ ...entry, experiment: proposalSemantics.proposalSemanticConfigurationSchema.parse(entry.experiment) }));
    const controls = JSON.parse(readFileSync(new URL('../../../../../tests/qualification/w05/scan-entry/control-cases.json', import.meta.url), 'utf8'));
    const test = await fixture('tool', true, 'audit', {}, false, {
      assetPath: manifest.assetPath,
      baseline: read(`baseline/${manifest.assetPath}`),
      proposal: {
        source: read(`proposed/${manifest.assetPath}`), timeoutMs: 5000, inputSchema: controls.inputSchema,
        outputSchema: { type: 'object', properties: { checked: { type: 'number' }, invalidLines: { type: 'array', items: { type: 'number' } } },
          required: ['checked', 'invalidLines'], additionalProperties: false },
        sideEffects: 'filesystem', idempotency: 'Replays the completed checkpoint', recovery: 'Resumes from the partial checkpoint',
        tests: cases.slice(0, 4).map(({ experiment }) => ({ kind: experiment.kind === 'refusal' ? 'refusal' : 'normal', input: experiment.input,
          expected: JSON.stringify(experiment.assertions[1].expected) })),
      },
    });
    const dockerConfiguration = join(test.root, 'docker-config');
    mkdirSync(dockerConfiguration);
    vi.stubEnv('DOCKER_CONFIG', dockerConfiguration);
    vi.stubEnv('DOCKER_CONTEXT', '');
    vi.stubEnv('DOCKER_HOST', 'unix:///var/run/docker.sock');
    vi.stubEnv('DOCKER_TLS_VERIFY', '');
    const runtime = new PluginRuntime();
    const workspace = await test.repository.prepare!(test.checker.runtime.request);
    const checkoutRoot = join(test.root, 'checkouts');
    mkdirSync(checkoutRoot);
    const checkoutPath = join(checkoutRoot, workspace.id);
    vi.mocked(test.repository.prepare!).mockImplementation(async request => {
      execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--quiet', '--no-local', '--', workspace.path!, checkoutPath]);
      return { ...workspace, ...request, path: checkoutPath };
    });
    vi.mocked(test.repository.checkout!).mockImplementation(async () => ({
      ...workspace, ...vi.mocked(test.repository.prepare!).mock.lastCall![0], path: checkoutPath,
    }));
    vi.mocked(test.repository.cleanup!).mockImplementation(async () => {
      rmSync(checkoutPath, { recursive: true });
      return { removed: true };
    });
    const repositoryRoot = workspace.path!;
    const expectedCommit = workspace.snapshot.commit;
    const catalogFile = join(test.root, 'catalog.json');
    const catalog = JSON.stringify({ version: 1, scope, repositoryRoot, expectedCommit,
      scanRoots: { skills: 'skills', cli: 'cli', script: 'script', plugin: 'plugin' }, skills: [],
      tools: test.checker.runtime.inventory.tools.map(tool => ({ ...tool, scope, expectedCommit, digest: bytesDigest(read(`baseline/${manifest.assetPath}`)) })) });
    writeFileSync(catalogFile, catalog, { mode: 0o600 });
    const configurationFile = join(test.root, 'checkers.json');
    const executionAuthorizationFile = join(test.root, 'execution.json');
    const scratchPath = join(test.root, 'scratch-helper');
    const scratchHelper = { path: scratchPath, digest: compileScratchFixture(scratchPath).digest };
    const events = new JsonlEventStore({ root: join(test.root, 'events') });
    const entry = { mode: 'repository-asset', scope, checkerId: test.input.checkerId, version: 'v1', kind: 'tool',
      executionAuthorizationFile, repository: { providerId: test.repository.id, repository: workspace.repository, root: repositoryRoot, expectedCommit },
      asset: { ref: test.prepared.artifact.targetRef, path: manifest.assetPath }, inventory: { file: catalogFile, digest: bytesDigest(catalog) },
      sandbox: { engine: 'docker', baseImageId: process.env.AFK_TEST_FROZEN_IMAGE!,
        permissionObserverImageId: process.env.AFK_TEST_W06_OBSERVER_IMAGE!, scratchHelper },
      semantic: { protocol: 'proposal-semantic-v1', adapter: 'node-json-argv-v1', revision: 'v1', cases: test.prepared.checks.map(check => ({
        checkId: check.id, checkDigest: digest(check), experiment: cases.find(entry => entry.checkId === check.id)!.experiment })) },
      evidence: [{ digest: test.pack.digest, sources: [{ id: 'audit', kind: 'audit', path: events.pathFor('source'), allowedRoot: events.root, runId: 'source' }] }] };
    writeFileSync(configurationFile, JSON.stringify({ version: 2, checkers: [entry] }), { mode: 0o600 });
    const writeGrant = (sideEffects: 'none' | 'filesystem') => writeFileSync(executionAuthorizationFile, JSON.stringify({
      version: 1, purpose: 'proposal-validation-execution', revoked: false, scope, checkerId: entry.checkerId, checkerVersion: entry.version,
      checkerDigest: digest(entry), kind: entry.kind, repository: entry.repository, asset: entry.asset, inventoryDigest: entry.inventory.digest,
      candidateId: test.candidate.id, candidateVersion: test.candidate.version, candidateDigest: test.candidate.digest, evidenceDigest: test.candidate.evidenceDigest,
      sandbox: entry.sandbox, adapter: { id: entry.semantic.adapter, revision: entry.semantic.revision, hostRuntimeRevision: PROPOSAL_VALIDATION_RUNTIME_REVISION },
      allowed: { dependencies: [], permissions: [], sideEffects }, limits: { timeoutMs: 5000, maxOutputBytes: DISTILLATION_LIMITS.outputBytes },
    }), { mode: 0o600 });
    const ownership = vi.spyOn(CandidateStore.prototype, 'recordProposalOwnership');
    await runtime.activate({ manifest: { id: 'repository.qualification', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['repository.provider'] },
      activate(context) { context.registerRepositoryProvider(test.repository.id, test.repository); } });
    await runtime.activate(createLearningPlugin({ homeDir: test.root, config: { enabled: true, validation: { configurationFile } } }));
    let result: Awaited<ReturnType<typeof validate>>;
    try {
      writeGrant('none');
      expect(await runtime.dispatchSystemAction('learning.validate', test.input)).toEqual(blocked('unauthorized'));
      expect(ownership).not.toHaveBeenCalled();
      writeGrant('filesystem');
      result = await runtime.dispatchSystemAction('learning.validate', test.input) as typeof result;
    } finally { await runtime.close(); }
    const reopened = new CandidateStore({ file: test.file });
    cleanups.push(() => reopened.close());
    const validation = reopened.getValidation(test.candidate.id);
    const operations = ownership.mock.results.flatMap(entry => entry.type === 'return' ? [entry.value.ownership.operationId] : []);
    const remaining = operations.flatMap(operation => ['container', 'image', 'volume'].map(kind => ({ operation, kind,
      ids: execFileSync('docker', [kind, 'ls', kind === 'volume' ? '-q' : '-aq', '--filter', `label=afk.frozen.operation=${operation}`], { encoding: 'utf8', timeout: 5000 }).trim() })));
    writeFileSync(join(bundle, 'configured-candidate-validation.json'), JSON.stringify({ result, registered: test.candidate, validation, operations, remaining }, null, 2));
    expect(existsSync(checkoutPath)).toBe(false);
    expect(remaining.every(entry => entry.ids === '')).toBe(true);
    expect(result.status).toBe('validated');
    expect(validation?.passed).toBe(true);
    expect(new Set(operations).size).toBe(16);
    expect(operations.every(operation => reopened.getProposalOwnership(operation)?.binding.candidateId === test.candidate.id)).toBe(true);
    expect(reopened.getCandidate(test.candidate.id)?.state).toBe('validated');
    const audit = Buffer.from(validation!.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64');
    expect(audit.length).toBeLessThanOrEqual(DISTILLATION_LIMITS.outputBytes);
    const saved = JSON.parse(audit.toString('utf8'));
    expect(saved.receiptDigest).toBe(digest(saved.report));
    expect(result).toMatchObject({ receiptDigest: saved.receiptDigest });
    expect(saved.report.comparisons).toHaveLength(8);
    for (const comparison of saved.report.comparisons) {
      for (const version of ['original', 'proposed'] as const) {
        const packed = comparison[version];
        expect(packed.receipt).not.toHaveProperty('actual');
        expect(digest({ ...packed.receipt, actual: packed.receipt.semantic.assertions, expected: comparison.expected,
          binding: { ...saved.report.observationBinding, ...comparison.binding, ...packed.receipt.binding } })).toBe(packed.receiptDigest);
      }
    }
  }, 150_000);

  it('runs actual frozen tool bytes and retains candidate state for unsupported business coverage', async () => {
    const test = await fixture('tool', false);
    const dockerConfiguration = join(test.root, 'docker-config');
    mkdirSync(dockerConfiguration);
    vi.stubEnv('DOCKER_CONFIG', dockerConfiguration);
    vi.stubEnv('DOCKER_CONTEXT', '');
    vi.stubEnv('DOCKER_HOST', 'unix:///var/run/docker.sock');
    vi.stubEnv('DOCKER_TLS_VERIFY', '');
    const provider = new DockerContainerProvider();
    const image = process.env.AFK_TEST_FROZEN_IMAGE!;
    expect(image).toMatch(/^sha256:[a-f0-9]{64}$/);
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'pipe', timeout: 5000 });
    test.checker.runtime.baseImageId = image;
    const operations: string[] = [];
    const executions: Awaited<ReturnType<typeof executeFrozenContainer>>[] = [];
    test.checker.runtime.recordOwnership = async ownership => { operations.push(ownership.operationId); };
    test.checker.runtime.sandbox = { executeFrozen: async request => {
      const result = await executeFrozenContainer(provider, request); executions.push(result); return result;
    } };
    const observe = test.checker.runtime.harness!.observe;
    test.checker.runtime.harness!.observe = async (...args) => args[1].checkId === test.prepared.checks[0].id
      ? observe(...args) : { status: 'unsupported', reason: 'business_semantics_not_configured' };
    expect(await validate(test.input, test.dependencies, { timeoutMs: 60000 })).toEqual(blocked('insufficient_coverage'));
    expect(executions).toHaveLength(2);
    expect(operations).toHaveLength(2);
    for (const execution of executions) {
      expect(execution).toMatchObject({ exitCode: 0, cleanup: { containerRemoved: true, imageRemoved: true }, evidence: { mechanism: 'docker-frozen-image' } });
      expect(JSON.parse(execution.stdout)).toEqual({ value: 'observed' });
    }
    for (const operation of operations) {
      const filter = `label=afk.frozen.operation=${operation}`;
      expect(execFileSync('docker', ['container', 'ls', '-aq', '--filter', filter], { encoding: 'utf8', timeout: 5000 }).trim()).toBe('');
      expect(execFileSync('docker', ['image', 'ls', '-aq', '--filter', filter], { encoding: 'utf8', timeout: 5000 }).trim()).toBe('');
    }
    expect(test.repository.cleanup).toHaveBeenCalledOnce(); test.unchanged();
  }, 90000);
});
