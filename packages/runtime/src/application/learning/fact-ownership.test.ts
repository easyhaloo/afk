import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CandidateStore, type LearningCandidate } from './candidate-store.js';
import { canonicalLearningJson } from './requests.js';
import { completeFixtureRequest, evidence, output, request } from './ledger-data.fixture.spec.js';

let root: string;
const stores: CandidateStore[] = [];
const digest = (value: unknown) => createHash('sha256').update(canonicalLearningJson(value)).digest('hex');
function open(limits?: ConstructorParameters<typeof CandidateStore>[0]['limits']) {
  const store = new CandidateStore({ file: join(root, 'private', 'ledger.sqlite'), limits });
  stores.push(store);
  return store;
}
function candidate(store: CandidateStore, callId?: string) {
  const source = store.submitRequest({ request, evidence: [evidence] });
  const result = completeFixtureRequest(store, source.key, output, callId);
  return store.getCandidate(result.candidateIds[0])!;
}
function registration(current: LearningCandidate) {
  const operationId = randomUUID();
  return {
    ownership: { operationId, engine: 'docker' as const, containerName: `afk-frozen-${operationId}`,
      baseImageId: `sha256:${'a'.repeat(64)}`, inputDigest: digest('input'), contextDigest: digest('context') },
    binding: { scope: request.scope, candidateId: current.id, candidateVersion: current.version, evidenceDigest: current.evidenceDigest },
    check: { executionId: 'verification:independent', checkerId: 'fact-rules', checkerVersion: '1',
      configurationDigest: digest('configuration'), authorizationDigest: digest('authorization'),
      checkerDigest: digest('checker'), requestDigest: digest('request'), targetDigest: digest('target'),
      workspace: { kind: 'repository' as const, providerId: 'multi-repository', id: 'owned:workspace',
        cwd: root, revision: 'b'.repeat(40) }, leaseId: 'lease:independent' },
  };
}
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'fact-ownership-'))); });
afterEach(() => { stores.splice(0).forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); });

describe('durable fact execution ownership', () => {
  it('persists immutable ownership across reopen without granting validation or publication', () => {
    const store = open();
    const current = candidate(store);
    const entry = registration(current);
    expect(store.recordFactOwnership(entry, () => undefined)).toEqual(entry);
    expect(store.recordFactOwnership(entry, () => undefined)).toEqual(entry);
    entry.check.targetDigest = digest('caller mutation');
    store.getFactOwnership(entry.ownership.operationId)!.check.leaseId = 'caller:mutation';
    store.close();
    const reopened = open();
    expect(reopened.getFactOwnership(entry.ownership.operationId)).toMatchObject({
      check: { targetDigest: digest('target'), leaseId: 'lease:independent' },
    });
    expect(reopened.listFactOwnership(request.scope)).toHaveLength(1);
    expect(reopened.listFactOwnership('github:other/project')).toEqual([]);
    expect(reopened.getCandidate(current.id)).toEqual(current);
    expect(reopened.getValidation(current.id)).toBeUndefined();
    expect(reopened.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('rejects conflicting bindings from another SQLite connection', () => {
    const store = open();
    const entry = registration(candidate(store));
    store.recordFactOwnership(entry, () => undefined);
    const other = open();
    expect(() => other.recordFactOwnership({ ...entry, check: { ...entry.check, targetDigest: digest('different') } },
      () => undefined)).toThrow(/different|conflict/i);
    expect(other.getFactOwnership(entry.ownership.operationId)).toEqual(entry);
  });

  it.each(['scope', 'candidateId', 'candidateVersion', 'evidenceDigest'] as const)('rejects a mismatched %s', field => {
    const store = open();
    const entry = registration(candidate(store));
    const wrong = { scope: 'github:other/project', candidateId: digest('missing'), candidateVersion: 2, evidenceDigest: digest('other') };
    expect(() => store.recordFactOwnership({ ...entry, binding: { ...entry.binding, [field]: wrong[field] } },
      () => undefined)).toThrow();
    expect(store.getFactOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('rejects stale candidate state and a blocked source', () => {
    const store = open();
    const current = candidate(store);
    const entry = registration(current);
    store.setRequestBlocked(current.requestKey, 'source_unavailable');
    expect(() => store.recordFactOwnership(entry, () => undefined)).toThrow(/blocked/i);
    store.setRequestBlocked(current.requestKey, null);
    store.transitionCandidate(current.id, current.version, 'rejected');
    expect(() => store.recordFactOwnership(entry, () => undefined)).toThrow(/version|state/i);
    expect(store.getFactOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('rejects a process candidate without granting executable ownership', () => {
    const store = open();
    const source = store.submitRequest({ request, evidence: [evidence] });
    const processed = store.completeRequest(source.key, { ...output, candidates: [{ ...output.candidates[0], kind: 'process', payload: {
      entry: 'Approval', systems: ['repository'], preconditions: [],
      steps: [{ id: 'approve', action: 'Approve', stateChange: 'approved', evidenceIds: ['e1'] }],
      exceptions: [], completion: 'approved',
    } }] });
    const current = store.getCandidate(processed.candidateIds[0])!;
    const entry = registration(current);
    expect(() => store.recordFactOwnership(entry, () => undefined)).toThrow(/fact/i);
    expect(store.getFactOwnership(entry.ownership.operationId)).toBeUndefined();
    expect(store.getCandidate(current.id)).toEqual(current);
  });

  it.each(['fact', 'proposal'] as const)('reserves an operation ID exclusively when %s ownership arrives first', first => {
    const store = open();
    const source = store.submitRequest({ request, evidence: [evidence] });
    const processed = store.completeRequest(source.key, { ...output, candidates: [output.candidates[0], {
      ...output.candidates[0], kind: 'tool', payload: {
        existingTools: [], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
        dependencies: [], permissions: [], timeoutMs: 500, sideEffects: 'none', idempotency: 'Pure', recovery: 'Retry',
        source: 'console.log(JSON.stringify({value:"ok"}));', tests: [
          { kind: 'normal', input: '{"key":"alpha"}', expected: '{"value":"ok"}' },
          { kind: 'normal', input: '{"key":"beta"}', expected: '{"value":"ok"}' },
          { kind: 'refusal', input: '{"key":"../unsafe"}', expected: '{"error":"refused"}' },
        ],
      },
    }] });
    const fact = registration(store.getCandidate(processed.candidateIds[0])!);
    const tool = store.getCandidate(processed.candidateIds[1])!;
    const proposal = { ownership: fact.ownership,
      binding: { ...fact.binding, candidateId: tool.id, candidateVersion: tool.version },
      check: { checkId: 'behavior-1', checkDigest: digest('check'), version: 'proposed',
        configurationDigest: digest('configuration'), commit: 'b'.repeat(40), inventoryDigest: digest('inventory'),
        artifactDigest: digest('artifact'), artifactPath: 'asset.js', workspaceId: 'owned:workspace', runId: 'validation:independent' },
    };
    if (first === 'fact') {
      store.recordFactOwnership(fact, () => undefined);
      expect(() => open().recordProposalOwnership(proposal)).toThrow(/already belongs/i);
      expect(store.getFactOwnership(fact.ownership.operationId)).toEqual(fact);
      expect(store.getProposalOwnership(fact.ownership.operationId)).toBeUndefined();
    } else {
      store.recordProposalOwnership(proposal);
      expect(() => open().recordFactOwnership(fact, () => undefined)).toThrow(/already belongs/i);
      expect(store.getProposalOwnership(fact.ownership.operationId)).toEqual(proposal);
      expect(store.getFactOwnership(fact.ownership.operationId)).toBeUndefined();
    }
  });

  it.each(['source', 'analysis-run', 'analysis-session'] as const)('rejects the %s identity as independent execution', identity => {
    const store = open();
    const current = candidate(store, 'analysis:call');
    store.recordAnalysisIdentity('analysis:call', { analysisRunId: 'analysis:run', sessionId: 'analysis:session' });
    const entry = registration(current);
    entry.check.executionId = { source: request.sourceRunId, 'analysis-run': 'analysis:run', 'analysis-session': 'analysis:session' }[identity];
    expect(() => store.recordFactOwnership(entry, () => undefined)).toThrow(/independent/i);
    expect(store.getFactOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it.each([
    (entry: ReturnType<typeof registration>) => ({ ...entry, ownership: { ...entry.ownership, containerName: 'another-container' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, ownership: { ...entry.ownership, contextDigest: 'invalid' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, authorizationDigest: 'invalid' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, workspace: { ...entry.check.workspace, cwd: '../outside' } } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, untrusted: true } }),
  ])('rejects malformed ownership without persistence (%#)', mutate => {
    const store = open();
    const entry = registration(candidate(store));
    expect(() => store.recordFactOwnership(mutate(entry), () => undefined)).toThrow();
    expect(store.getFactOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('requires a synchronous current-authority guard and rolls back when it fails', () => {
    const store = open();
    const entry = registration(candidate(store));
    expect(() => store.recordFactOwnership(entry, undefined as unknown as () => void)).toThrow(/guard/i);
    expect(() => store.recordFactOwnership(entry, () => { throw new Error('grant revoked'); })).toThrow('grant revoked');
    expect(() => store.recordFactOwnership(entry, (() => Promise.resolve()) as () => void)).toThrow(/synchronous/i);
    expect(store.getFactOwnership(entry.ownership.operationId)).toBeUndefined();
    expect(store.recordFactOwnership(entry, () => undefined)).toEqual(entry);
  });

  it('rejects nested candidate mutations atomically', () => {
    const store = open();
    const current = candidate(store);
    const entry = registration(current);
    expect(() => store.recordFactOwnership(entry, () => { store.transitionCandidate(current.id, current.version, 'rejected'); })).toThrow();
    expect(store.getFactOwnership(entry.ownership.operationId)).toBeUndefined();
    expect(store.getCandidate(current.id)).toEqual(current);
  });

  it('fails atomically when the ledger is full', () => {
    const store = open();
    const entry = registration(candidate(store));
    store.close();
    expect(() => open({ records: 1 }).recordFactOwnership(entry, () => undefined)).toThrow(/capacity/i);
    expect(open().getFactOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('validates lookup identities and rejects access after close', () => {
    const store = open();
    expect(store.getFactOwnership(randomUUID())).toBeUndefined();
    expect(() => store.getFactOwnership('../outside')).toThrow();
    expect(() => store.listFactOwnership('../outside')).toThrow();
    store.close();
    expect(() => store.getFactOwnership(randomUUID())).toThrow(/closed/i);
    expect(() => store.listFactOwnership(request.scope)).toThrow(/closed/i);
  });
});
