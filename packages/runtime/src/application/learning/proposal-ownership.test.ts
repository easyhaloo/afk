import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
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
const tool = { ...output.candidates[0], kind: 'tool', payload: {
  existingTools: [], inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
  dependencies: [], permissions: [], timeoutMs: 500, sideEffects: 'none', idempotency: 'Pure', recovery: 'Retry',
  source: 'console.log(JSON.stringify({value:"ok"}));', tests: [
    { kind: 'normal', input: '{"key":"alpha"}', expected: '{"value":"ok"}' },
    { kind: 'normal', input: '{"key":"beta"}', expected: '{"value":"ok"}' },
    { kind: 'refusal', input: '{"key":"../unsafe"}', expected: '{"error":"refused"}' },
  ],
} };

function open(limits?: ConstructorParameters<typeof CandidateStore>[0]['limits']) {
  const store = new CandidateStore({ file: join(root, 'private', 'ledger.sqlite'), limits });
  stores.push(store);
  return store;
}

function candidate(store: CandidateStore, proposal: unknown = tool, callId?: string) {
  const source = store.submitRequest({ request, evidence: [evidence] });
  const result = completeFixtureRequest(store, source.key, { version: 1, candidates: [proposal], warnings: [] }, callId);
  return store.getCandidate(result.candidateIds[0])!;
}

function registration(current: LearningCandidate) {
  const operationId = randomUUID();
  return {
    ownership: { operationId, engine: 'docker' as const, containerName: `afk-frozen-${operationId}`,
      baseImageId: `sha256:${'a'.repeat(64)}`, inputDigest: digest('input'), contextDigest: digest('context') },
    binding: { scope: request.scope, candidateId: current.id, candidateVersion: current.version, evidenceDigest: current.evidenceDigest },
    check: { checkId: 'behavior-1', checkDigest: digest('check'), version: 'proposed' as const,
      configurationDigest: digest('configuration'), commit: 'b'.repeat(40), inventoryDigest: digest('inventory'),
      artifactDigest: digest('artifact'), artifactPath: 'asset.js', workspaceId: 'owned:workspace', runId: 'validation:independent' },
  };
}

beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'proposal-ownership-'))); });
afterEach(() => { stores.splice(0).forEach(store => store.close()); rmSync(root, { recursive: true, force: true }); });

describe('durable proposal execution ownership', () => {
  it('persists the full immutable binding across reopen without validating the candidate', () => {
    const store = open();
    const current = candidate(store);
    const entry = registration(current);
    expect(store.recordProposalOwnership(entry)).toEqual(entry);
    expect(store.recordProposalOwnership(entry)).toEqual(entry);
    entry.check.artifactDigest = digest('caller mutation');
    const persisted = store.getProposalOwnership(entry.ownership.operationId)!;
    persisted.check.runId = 'caller:mutation';
    store.close();
    const reopened = open();
    expect(reopened.getProposalOwnership(entry.ownership.operationId)).toMatchObject({
      check: { artifactDigest: digest('artifact'), runId: 'validation:independent' },
    });
    expect(reopened.getCandidate(current.id)).toEqual(current);
    expect(reopened.getValidation(current.id)).toBeUndefined();
  });

  it('rejects conflicting content across separate SQLite connections', () => {
    const store = open();
    const entry = registration(candidate(store));
    store.recordProposalOwnership(entry);
    const second = open();
    expect(() => second.recordProposalOwnership({ ...entry, check: { ...entry.check, artifactDigest: digest('different') } })).toThrow(/different|conflict/i);
    expect(second.getProposalOwnership(entry.ownership.operationId)).toEqual(entry);
  });

  it('records skill ownership using the same durable ledger', () => {
    const store = open();
    const current = candidate(store, { ...output.candidates[0], kind: 'skill', payload: {
      newReason: 'No existing recovery skill', triggers: ['recover'], prohibitedConditions: ['missing authorization'],
      inputs: [{ name: 'job', description: 'Job identifier', required: true }], branches: ['normal', 'retry'],
      recovery: ['Resume from checkpoint'], completion: 'Job verified', patch: 'Recover the authorized job.',
      evaluationCases: [{ kind: 'normal', input: 'job A', expected: 'Completed' },
        { kind: 'recovery', input: 'interrupted job B', expected: 'Resumed' },
        { kind: 'refusal', input: 'unauthorized job C', expected: 'Refused' }],
    } });
    const entry = registration(current);
    expect(store.recordProposalOwnership(entry)).toEqual(entry);
    expect(store.getProposalOwnership(entry.ownership.operationId)).toEqual(entry);
  });

  it.each(['scope', 'candidateId', 'candidateVersion', 'evidenceDigest'] as const)('rejects a mismatched candidate %s', field => {
    const store = open();
    const entry = registration(candidate(store));
    const wrong = { scope: 'github:other/project', candidateId: digest('missing'), candidateVersion: 2, evidenceDigest: digest('other') };
    expect(() => store.recordProposalOwnership({ ...entry, binding: { ...entry.binding, [field]: wrong[field] } })).toThrow();
    expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('rejects a candidate that changed state before registration', () => {
    const store = open();
    const current = candidate(store);
    const entry = registration(current);
    store.transitionCandidate(current.id, current.version, 'rejected');
    expect(() => store.recordProposalOwnership(entry)).toThrow(/version|state/i);
    expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('rejects knowledge candidates as executable ownership targets', () => {
    const store = open();
    const source = store.submitRequest({ request, evidence: [evidence] });
    const processed = store.completeRequest(source.key, output);
    const entry = registration(store.getCandidate(processed.candidateIds[0])!);
    expect(() => store.recordProposalOwnership(entry)).toThrow(/asset|kind/i);
    expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('rejects a blocked source and preserves the existing candidate', () => {
    const store = open();
    const current = candidate(store);
    const entry = registration(current);
    store.setRequestBlocked(current.requestKey, 'source_unavailable');
    expect(() => store.recordProposalOwnership(entry)).toThrow(/blocked/i);
    expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
    expect(store.getCandidate(current.id)).toEqual(current);
  });

  it.each(['r1', 'analysis:run', 'analysis:session'])('rejects a source or analysis identity as the validation run (%s)', runId => {
    const store = open();
    const current = candidate(store, tool, 'analysis:call');
    store.recordAnalysisIdentity('analysis:call', { analysisRunId: 'analysis:run', sessionId: 'analysis:session' });
    const entry = registration(current);
    expect(() => store.recordProposalOwnership({ ...entry, check: { ...entry.check, runId } })).toThrow(/independent/i);
    expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it.each([
    (entry: ReturnType<typeof registration>) => ({ ...entry, extra: true }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, ownership: { ...entry.ownership, operationId: 'invalid' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, ownership: { ...entry.ownership, engine: 'podman' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, ownership: { ...entry.ownership, containerName: 'foreign-container' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, artifactPath: '../escape' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, artifactPath: '/absolute' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, artifactPath: 'nested\\asset.js' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, artifactPath: '.git/config' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, artifactPath: '.GIT/config' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, version: 'unknown' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, commit: 'main' } }),
    (entry: ReturnType<typeof registration>) => ({ ...entry, check: { ...entry.check, checkDigest: 'invalid' } }),
  ])('rejects malformed ownership without writing a record (%#)', mutate => {
    const store = open();
    const entry = registration(candidate(store));
    expect(() => store.recordProposalOwnership(mutate(entry))).toThrow();
    expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('runs a synchronous guard inside the write transaction and rolls back on failure', () => {
    const store = open();
    const entry = registration(candidate(store));
    expect(() => store.recordProposalOwnership(entry, () => { throw new Error('grant revoked'); })).toThrow('grant revoked');
    expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
    expect(() => store.recordProposalOwnership(entry, (() => Promise.resolve()) as () => void)).toThrow(/synchronous/i);
    expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
    expect(store.recordProposalOwnership(entry, () => undefined)).toEqual(entry);
  });

  it('rolls back ownership when ledger capacity is exhausted', () => {
    const store = open();
    const entry = registration(candidate(store));
    store.close();
    const constrained = open({ records: 1 });
    expect(() => constrained.recordProposalOwnership(entry)).toThrow(/capacity/i);
    expect(open().getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
  });

  it('validates lookup identities and refuses reads after close', () => {
    const store = open();
    expect(store.getProposalOwnership(randomUUID())).toBeUndefined();
    expect(() => store.getProposalOwnership('../unsafe')).toThrow();
    store.close();
    expect(() => store.getProposalOwnership(randomUUID())).toThrow(/closed/i);
  });

  it.each(['ownership', 'validation', 'prepare', 'supersede', 'advance'] as const)(
    'rolls back rejected asynchronous guards without terminating the process (%s)', operation => {
      const store = open();
      const current = candidate(store);
      const entry = registration(current);
      const validation = { candidateDigest: current.digest, evidenceDigest: current.evidenceDigest,
        validatorVersion: 'guard:v1', passed: true, results: ['verified'] };
      const publication = { key: 'publish:original', validatorVersion: 'guard:v1', targetRef: 'script:fixture',
        originalDigest: digest('original'), targetDigest: digest('proposed'), recoveryRef: 'backup:fixture' };
      if (!['ownership', 'validation'].includes(operation)) store.recordValidation(current.id, 1, validation);
      if (['supersede', 'advance'].includes(operation)) store.preparePublication(current.id, 2, publication);
      const before = { candidate: store.getCandidate(current.id), validation: store.getValidation(current.id),
        publication: store.getPublication(publication.key) };
      const calls = {
        ownership: 'store.recordProposalOwnership(entry, guard)',
        validation: 'store.recordValidation(entry.binding.candidateId, 1, validation, guard)',
        prepare: 'store.preparePublication(entry.binding.candidateId, 2, publication, guard)',
        supersede: 'store.supersedePreparedPublication(publication.key, { ...publication, key: "publish:replacement" }, guard)',
        advance: 'store.advancePublication(publication.key, "applied", publication.targetDigest, guard)',
      };
      const script = `
        import { CandidateStore } from ${JSON.stringify(new URL('./candidate-store.ts', import.meta.url).href)};
        const store = new CandidateStore({ file: ${JSON.stringify(join(root, 'private', 'ledger.sqlite'))} });
        const entry = ${JSON.stringify(entry)};
        const validation = ${JSON.stringify(validation)};
        const publication = ${JSON.stringify(publication)};
        const guard = async () => { throw new Error('expected guard rejection'); };
        let rejected = false;
        try { ${calls[operation]}; }
        catch (error) { if (!error.message.includes('synchronous')) throw error; rejected = true; }
        finally { store.close(); }
        if (!rejected) throw new Error('Guard unexpectedly accepted');
        setImmediate(() => console.log('caller survived'));
      `;
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script],
        { encoding: 'utf8', timeout: 10000, stdio: 'pipe', env: { ...process.env } });
      expect(result.error).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('caller survived');
      expect(store.getProposalOwnership(entry.ownership.operationId)).toBeUndefined();
      expect(store.getPublication('publish:replacement')).toBeUndefined();
      expect({ candidate: store.getCandidate(current.id), validation: store.getValidation(current.id),
        publication: store.getPublication(publication.key) }).toEqual(before);
    },
  );
});
