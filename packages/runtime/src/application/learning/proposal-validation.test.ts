import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateStore } from './candidate-store.js';
import type { CandidateProposal } from './contracts.js';
import { buildEvidencePack } from './evidence.js';
import { output } from './ledger-data.fixture.spec.js';
import { prepareAssetProposal, type ProposalInventory } from './proposals.js';
import { canonicalLearningJson } from './requests.js';
import type { ProposalValidationChecker, ProposalValidationDependencies } from './proposal-validation.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { DockerContainerProvider } from '../../infrastructure/sandbox/container/docker.js';
import { executeFrozenContainer } from '../../infrastructure/sandbox/container/frozen-execution.js';
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
  identity: { sourceRunId?: string | null; sourceId?: string; auditRunId?: string; secondAuditRunId?: string; validationRunId?: string; imported?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'proposal-validation-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'private', 'ledger.sqlite');
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
  const artifactPath = kind === 'tool' ? 'asset.js' : 'SKILL.md';
  const original = kind === 'tool' ? 'console.log("baseline");\n' : '---\nname: recover\ndescription: Recover fixture\ndisable-model-invocation: true\nuser-invocable: false\n---\nRecover fixture safely.\n';
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
    'disable-model-invocation': true, 'user-invocable': false, 'allowed-tools': [], 'disallowed-tools': [],
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
      ] } } : { kind: 'skill', ...(existing ? { targetRef: 'skill:recover' } : {}), payload: {
      ...(existing ? { targetSkill: 'skill:recover', originalDigest: bytesDigest(original) } : { newReason: 'No matching skill exists' }),
      triggers: ['Explicit recovery request'], prohibitedConditions: ['No permission'], inputs: [{ name: 'target', description: 'Owned target', required: true }],
      branches: ['Verify ownership first'], recovery: ['Stop on refusal'], completion: 'Owned target recovered', patch: 'Bound recovery to the owned target',
      evaluationCases: [{ kind: 'normal', input: 'recover owned', expected: 'candidate claims success' },
        { kind: 'refusal', input: 'recover foreign', expected: 'refuse' }, { kind: 'recovery', input: 'retry interrupted', expected: 'recover' }] } }) };
  const processed = store.completeRequest(source.key, { version: 1, candidates: [proposal], warnings: [] });
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
      expect(digest({ ...observation.receipt, binding: { ...saved.report.observationBinding, ...observation.receipt.binding } })).toBe(observation.receiptDigest);
    }
    const reopened = new CandidateStore({ file: test.file });
    try { expect(reopened.getCandidate(test.candidate.id)?.state).toBe('validated'); expect(reopened.getValidation(test.candidate.id)).toEqual(receipt); }
    finally { reopened.close(); }
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
    const test = await fixture();
    test.store.startAnalysisAttempt({ requestKey: test.source.key, callId: 'analysis-fixture', day: '2026-11-12', limit: 1,
      startedAt: '2026-11-12T00:00:00Z' });
    const record = test.store.recordValidation.bind(test.store);
    vi.spyOn(test.store, 'recordValidation').mockImplementation((...args) => {
      test.store.recordAnalysisIdentity('analysis-fixture', { analysisRunId: 'independent-analysis', sessionId: test.checker.runtime.request.runId });
      return record(...args);
    });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked('target_mismatch')); test.unchanged();
  });

  it.each(['source', 'grant', 'configuration', 'target', 'runtime', 'runtime-version'] as const)('rechecks %s at the final synchronous commit boundary', async mode => {
    const test = await fixture();
    const record = test.store.recordValidation.bind(test.store);
    vi.spyOn(test.store, 'recordValidation').mockImplementation((...args) => {
      if (mode === 'source') { test.current.source.current = false; test.persist(); }
      if (mode === 'grant') { test.current.authorization.authorizationDigest = digest('replacement-grant'); test.persist(); }
      if (mode === 'configuration') test.checker.configurationDigest = digest('replacement-config');
      if (mode === 'target') test.checker.target.snapshotDigest = digest('replacement-target');
      if (mode === 'runtime') test.checker.runtime.sandbox.executeFrozen = async () => { throw new Error('replacement-runtime'); };
      if (mode === 'runtime-version') test.checker.runtimeVersion = 'fixture-runtime-v2';
      return record(...args);
    });
    expect(await validate(test.input, test.dependencies)).toEqual(blocked(mode === 'source' ? 'source_unavailable' : mode === 'grant'
      ? 'authorization_changed' : mode === 'target' ? 'target_mismatch' : 'checker_changed')); test.unchanged();
  });

  it('accepts an own-data null-prototype DTO and a tool with no original baseline', async () => {
    const test = await fixture('tool', false);
    expect(await validate(Object.assign(Object.create(null), test.input), test.dependencies)).toMatchObject({ status: 'validated' });
    expect(test.engine.startFrozenContainer).toHaveBeenCalledTimes(test.prepared.checks.length);
    const validation = test.store.getValidation(test.candidate.id)!;
    const saved = JSON.parse(Buffer.from(validation.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString());
    expect(saved.report.comparisons.every((comparison: { original?: unknown }) => comparison.original === undefined)).toBe(true);
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
    const test = await fixture();
    const controller = new AbortController();
    if (mode === 'unauthorized') { test.current.authorization.allowed = false; test.persist(); }
    if (mode === 'pre-aborted') controller.abort();
    if (mode === 'checker') vi.mocked(test.dependencies.resolveChecker).mockResolvedValue(undefined);
    if (mode === 'candidate') test.input.candidateId = 'f'.repeat(64);
    if (mode === 'source-run') test.checker.runtime.request = { ...test.checker.runtime.request, runId: 'source' };
    if (mode === 'analysis-run') {
      test.store.startAnalysisAttempt({ requestKey: test.source.key, callId: 'analysis-fixture', day: '2026-11-12', limit: 1, startedAt: '2026-11-12T00:00:00Z' });
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

  it.each(['cancel', 'deadline'] as const)('aborts %s without allowing a late oracle to commit', async mode => {
    const test = await fixture();
    const controller = new AbortController();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const active = new Promise<void>(resolve => { entered = resolve; });
    test.checker.runtime.harness!.observe = async () => { entered!(); await new Promise<void>(resolve => { release = resolve; });
      return { status: 'observed', actual: { value: 'observed' }, assertions: 1 }; };
    const recording = validate(test.input, test.dependencies, { signal: controller.signal, timeoutMs: mode === 'deadline' ? 1000 : 5000 });
    await active;
    if (mode === 'cancel') controller.abort();
    expect(await recording).toEqual(blocked(mode === 'deadline' ? 'timed_out' : 'cancelled'));
    release!();
    await vi.waitFor(() => expect(test.repository.cleanup).toHaveBeenCalledOnce());
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
    const worker = new Worker(`const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite'); const fs = require('node:fs');
      const database = new DatabaseSync(workerData.file); const state = new Int32Array(workerData.coordination);
      parentPort.postMessage('ready'); Atomics.wait(state, 0, 0); database.exec('BEGIN IMMEDIATE');
      Atomics.store(state, 1, 1); Atomics.notify(state, 1); Atomics.wait(state, 0, 1, workerData.delay);
      if (workerData.revoke) { const value = JSON.parse(fs.readFileSync(workerData.stateFile)); value.authorization.allowed = false; fs.writeFileSync(workerData.stateFile, JSON.stringify(value)); }
      database.exec('COMMIT'); database.close();`, { eval: true, workerData: { file: test.file, coordination, stateFile: test.stateFile, revoke: mode === 'revocation', delay: mode === 'deadline' ? 2700 : 150 } });
    cleanups.push(() => { void worker.terminate(); });
    await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
    const record = test.store.recordValidation.bind(test.store);
    vi.spyOn(test.store, 'recordValidation').mockImplementation((...args) => {
      Atomics.store(state, 0, 1); Atomics.notify(state, 0);
      expect(Atomics.wait(state, 1, 0, 1000)).not.toBe('timed-out');
      return record(...args);
    });
    expect(await validate(test.input, test.dependencies, { timeoutMs: mode === 'deadline' ? 2500 : 5000 })).toEqual(blocked(mode === 'deadline' ? 'timed_out' : 'unauthorized'));
    expect(test.store.recordValidation).toHaveBeenCalledOnce(); test.unchanged();
  });
});

describe.runIf(process.env.AFK_TEST_FROZEN_DOCKER === '1')('candidate use case with the local Docker engine', () => {
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
