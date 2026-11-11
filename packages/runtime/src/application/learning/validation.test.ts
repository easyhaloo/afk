import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { TestRunnerVerificationProvider } from '../../infrastructure/verification/index.js';
import type { VerificationProvider, VerificationRequest } from '../../plugin-sdk/capabilities.js';
import { CandidateStore } from './candidate-store.js';
import type { CandidateProposal } from './contracts.js';
import { buildEvidencePack } from './evidence.js';
import { canonicalLearningJson } from './requests.js';
import { validateLearningCandidate, type LearningValidationChecker, type LearningValidationDependencies } from './validation.js';

const scope = 'github:acme/api';
const hash = (input: unknown) => createHash('sha256').update(canonicalLearningJson(input)).digest('hex');
const resources: Array<() => void> = [];
afterEach(() => { vi.useRealTimers(); resources.splice(0).reverse().forEach(clean => clean()); });

type Assertion = { node: string; expected: string | string[]; actual: string | string[];
  status: 'observed' | 'unknown' | 'inferred'; evidence: Array<{ id: string; digest: string; locator: string }> };
type Report = { protocol: string; binding: {
  scope: string; candidateId: string; candidateVersion: number; candidateDigest: string; evidenceDigest: string;
  target: LearningValidationChecker['target']; checkerId: string; checkerVersion: string;
  configurationDigest: string; authorizationDigest: string; executionId: string;
}; assertions: Assertion[] };

async function setup(kind: 'fact' | 'process' = 'fact', snapshot = true, observed = true,
  transform: (proposal: CandidateProposal) => CandidateProposal = proposal => proposal) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-validation-'));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new CandidateStore({ file: join(root, 'private', 'ledger.sqlite') });
  resources.push(() => store.close());
  const events = new JsonlEventStore({ root });
  await events.append([{ id: 'event-1', schemaVersion: 1, type: 'agent.session_recorded',
    occurredAt: '2026-11-09T00:00:00Z', context: { runId: 'run-1', traceId: 'trace-1', workItemId: `${scope}#1`,
      profileId: 'profile-1', attempt: 1, actor: { kind: 'system', id: 'fixture' } }, correlationId: 'run-1',
    data: { kind: 'agent.session_recorded', sessionId: 'session-1' } }]);
  const path = join(root, `${Buffer.from('run-1').toString('base64url')}.jsonl`);
  const sourceInput = { id: 'audit-1', kind: observed ? 'audit' as const : 'journal' as const,
    path, allowedRoot: root, runId: 'run-1' };
  const pack = await buildEvidencePack({ sources: [sourceInput] });
  const refs = pack.entries.map(entry => entry.ref);
  const proposal: CandidateProposal = transform({ title: 'Approval policy', statement: 'Approval precedes publication',
    evidenceIds: [refs[0].id], applicability: { project: scope, environments: [], versions: [], preconditions: [],
      exclusions: [], invalidationConditions: [] }, targetRef: 'policy:approval',
    ...(kind === 'fact' ? { kind: 'fact', payload: { subject: 'release', rule: 'approval required', classification: 'fact' } }
      : { kind: 'process', payload: { entry: 'draft', systems: ['release-service'], preconditions: ['authenticated'],
        steps: [{ id: 'approve', action: 'approve', stateChange: 'draft -> approved', evidenceIds: [refs[0].id] },
          { id: 'publish', action: 'publish', stateChange: 'approved -> published', evidenceIds: [refs[0].id] }],
        exceptions: ['denied -> draft'], completion: 'published' } }) });
  const source = store.submitRequest({ request: { version: 1, scope, sourceId: 'run:run-1', sourceRunId: 'run-1',
    evidenceDigest: pack.digest, analyzerVersion: 'fixture-1', reason: 'completed' }, evidence: refs }, snapshot ? pack : undefined);
  const processed = store.completeRequest(source.key, { version: 1, candidates: [proposal], warnings: [] });
  const candidate = store.getCandidate(processed.candidateIds[0])!;
  const oracle = join(root, 'policy.json');
  writeFileSync(oracle, JSON.stringify({ subject: 'release', rule: 'approval required', entry: 'draft',
    systems: ['release-service'], preconditions: ['authenticated'], actions: ['approve', 'publish'],
    approvedState: 'approved', authority: refs.map(ref => ref.locator).sort() }));
  const observedValues = (): Record<string, string | string[]> => {
    const policy = JSON.parse(readFileSync(oracle, 'utf8'));
    const perform = (state: string, action: string, authorized: boolean): string => {
      if (!authorized) return state;
      if (action === 'approve' && state === 'draft') return policy.approvedState;
      if (action === 'publish' && state === 'approved') return 'published';
      return state;
    };
    let state = policy.entry;
    const actual: Record<string, string | string[]> = { 'fact.subject': policy.subject, 'fact.rule': policy.rule,
      'fact.authority': policy.authority, 'process.entry': state, 'process.systems': policy.systems,
      'process.preconditions': policy.preconditions,
      'process.exceptions': [`denied -> ${perform('draft', 'approve', false)}`] };
    policy.actions.forEach((action: string, index: number) => {
      const previous = state;
      state = perform(state, action, true);
      actual[`process.steps.${index}.action`] = action;
      actual[`process.steps.${index}.stateChange`] = `${previous} -> ${state}`;
    });
    return { ...actual, 'process.completion': state };
  };
  let alter: (report: Report) => Report = report => report;
  let run: (() => void | Promise<void>) | undefined;
  const requests: VerificationRequest[] = [];
  const provider: VerificationProvider = { id: 'business-policy', capabilities: { 'test-execution': true,
    'static-analysis': false, 'custom-script': false },
    doctor: vi.fn(async () => [{ check: 'learning-validation-v1', ok: true }]),
    verify: vi.fn(async request => {
      requests.push(request);
      const envelope = JSON.parse(request.target);
      const actual = observedValues();
      const report: Report = { protocol: envelope.protocol, binding: envelope.binding,
        assertions: envelope.assertions.map((assertion: Assertion) => ({ ...assertion,
          actual: actual[assertion.node], status: 'observed' })) };
      await run?.();
      return { passed: true, durationMs: 1, output: JSON.stringify(alter(report)) };
    }) };
  const grantFile = join(root, 'grant.json');
  writeFileSync(grantFile, JSON.stringify({ allowed: true, version: 1 }), { mode: 0o600 });
  const readAuthorization = () => {
    const raw = readFileSync(grantFile, 'utf8');
    return { allowed: JSON.parse(raw).allowed as boolean, authorizationDigest: hash(raw) };
  };
  let version = '1';
  let configurationDigest = hash('checker-1');
  let targetScope = scope;
  const readChecker = (): LearningValidationChecker => ({ id: 'approval-policy', version,
    configurationDigest, mode: 'independent-assertions', provider,
    target: { scope: targetScope, ref: 'policy:approval', revision: 'revision-1', snapshotDigest: hash(readFileSync(oracle, 'utf8')) } });
  const deps: LearningValidationDependencies = { store,
    reconcile: vi.fn(async () => {
      const current = await buildEvidencePack({ sources: [{ ...sourceInput, expectedDigest: pack.sources[0].sourceDigest }] });
      return { current: current.completeness === 'complete', evidenceDigest: current.digest };
    }),
    authorize: vi.fn(async () => readAuthorization()),
    resolveChecker: vi.fn(async () => readChecker()),
    readCommitSnapshot: vi.fn(() => ({ authorization: readAuthorization(),
      source: { current: createHash('sha256').update(readFileSync(path)).digest('hex') === pack.sources[0].sourceDigest, evidenceDigest: pack.digest },
      checker: readChecker() })),
  };
  const input = { scope, candidateId: candidate.id, expectedVersion: 1, checkerId: 'approval-policy' };
  return { store, source, candidate, pack, refs, input, deps, provider, requests, oracle, sourcePath: path, grantFile,
    alter: (callback: typeof alter) => { alter = callback; }, during: (callback: typeof run) => { run = callback; },
    deny: () => { writeFileSync(grantFile, JSON.stringify({ allowed: false, version: 1 })); },
    changeGrant: () => { writeFileSync(grantFile, JSON.stringify({ allowed: true, version: 2 })); },
    changeChecker: () => { version = '2'; }, changeConfig: () => { configurationDigest = hash('checker-2'); },
    wrongTargetScope: () => { targetScope = 'github:other/api'; } };
}

function blocked(code: string) { return { status: 'blocked', code }; }

describe('validateLearningCandidate production boundary', () => {
  it.each(['fact', 'process'] as const)('runs independent %s assertions from an actual snapshot and stores auditable bindings', async kind => {
    const fixture = await setup(kind);
    const result = await validateLearningCandidate(fixture.input, fixture.deps);
    expect(result).toMatchObject({ status: 'validated', candidateId: fixture.candidate.id, candidateVersion: 1, validatedVersion: 2 });
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('validated');
    expect(fixture.deps.reconcile).toHaveBeenCalledTimes(2);
    expect(fixture.deps.authorize).toHaveBeenCalledTimes(2);
    expect(fixture.deps.resolveChecker).toHaveBeenCalledTimes(2);
    expect(fixture.provider.doctor).toHaveBeenCalledTimes(2);
    expect(fixture.requests[0]).not.toHaveProperty('command');
    const envelope = JSON.parse(fixture.requests[0].target);
    expect(envelope.evidence.digest).toBe(fixture.pack.digest);
    expect(envelope.candidate.proposal).toEqual(fixture.candidate.proposal);
    expect(envelope.binding).toMatchObject({ scope, candidateId: fixture.candidate.id, candidateVersion: 1,
      candidateDigest: fixture.candidate.digest, evidenceDigest: fixture.pack.digest,
      checkerId: fixture.input.checkerId, checkerVersion: '1', target: { scope, revision: 'revision-1' } });
    expect(envelope.binding.executionId).toMatch(/^[a-f0-9-]{36}$/);
    const receipt = fixture.store.getValidation(fixture.candidate.id)!;
    const audit = JSON.parse(Buffer.from(receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString('utf8'));
    expect(audit.report.binding).toEqual(envelope.binding);
    expect(audit.report.assertions.every((entry: Assertion) => entry.expected !== undefined && entry.actual !== undefined && entry.evidence.length)).toBe(true);
    expect(receipt.validatorVersion).toBe(`learning-validation-v1:${envelope.binding.executionId}`);
    expect(JSON.stringify(result)).not.toContain('approval required');
  });

  it.each(['passed', 'command', 'report', 'provider', 'target', 'checkerVersion'])('rejects client field %s before any dependency', async key => {
    const fixture = await setup();
    expect(await validateLearningCandidate({ ...fixture.input, [key]: true }, fixture.deps)).toEqual(blocked('invalid_input'));
    expect(fixture.deps.reconcile).not.toHaveBeenCalled();
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it('requires the loaded scope and optimistic version before executing', async () => {
    const fixture = await setup();
    expect(await validateLearningCandidate({ ...fixture.input, scope: 'github:other/api' }, fixture.deps)).toEqual(blocked('scope_mismatch'));
    expect(await validateLearningCandidate({ ...fixture.input, expectedVersion: 2 }, fixture.deps)).toEqual(blocked('stale_candidate'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it.each([false, true])('requires a real complete authoritative evidence snapshot (missing=%s)', async missing => {
    const fixture = await setup('fact', !missing, missing);
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked(missing ? 'evidence_unavailable' : 'insufficient_evidence'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it('does not treat provider.passed, exit 0, static analysis or model text as semantic proof', async () => {
    const fixture = await setup();
    for (const output of [undefined, 'exit 0', 'All keywords match; I judge this passed', '{"passed":true}', JSON.stringify(fixture.candidate.proposal)]) {
      vi.mocked(fixture.provider.verify).mockResolvedValueOnce({ passed: true, durationMs: 1, output });
      expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('invalid_receipt'));
    }
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('requires a configured checker with test-execution capability', async () => {
    const fixture = await setup();
    vi.mocked(fixture.deps.resolveChecker).mockResolvedValueOnce(undefined);
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('checker_unavailable'));
    Object.assign(fixture.provider.capabilities, { 'test-execution': false });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('checker_unavailable'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it.each(['scope', 'candidateId', 'candidateVersion', 'candidateDigest', 'evidenceDigest', 'checkerId',
    'checkerVersion', 'configurationDigest', 'authorizationDigest', 'executionId', 'target'])( 'rejects a forged %s binding', async field => {
    const fixture = await setup();
    fixture.alter(report => ({ ...report, binding: { ...report.binding, [field]: 'forged' } }));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('binding_mismatch'));
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
  });

  it.each(['missing', 'duplicate', 'extra', 'unknown', 'inferred', 'wrong-expected', 'wrong-actual', 'wrong-locator', 'wrong-evidence', 'secret-field'])(
    'rejects incomplete or unobserved coverage: %s', async fault => {
      const fixture = await setup('process');
      fixture.alter(report => {
        const assertion = report.assertions[0];
        if (fault === 'missing') report.assertions.splice(3, 1);
        if (fault === 'duplicate') report.assertions.push(assertion);
        if (fault === 'extra') report.assertions.push({ ...assertion, node: 'unrequested' });
        if (fault === 'unknown' || fault === 'inferred') assertion.status = fault;
        if (fault === 'wrong-expected') assertion.expected = 'invented';
        if (fault === 'wrong-actual') assertion.actual = 'invented';
        if (fault === 'wrong-locator') assertion.evidence[0].locator = 'somewhere-else';
        if (fault === 'wrong-evidence') assertion.evidence[0].digest = '0'.repeat(64);
        if (fault === 'secret-field') Object.assign(assertion, { secret: 'private-token' });
        return report;
      });
      expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('blocked');
      expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
    });

  it.each(['fact', 'process'] as const)('fails %s when actual business assertions differ, even with provider.passed=true', async kind => {
    const fixture = await setup(kind);
    const policy = JSON.parse(readFileSync(fixture.oracle, 'utf8'));
    writeFileSync(fixture.oracle, JSON.stringify({ ...policy, rule: 'no approval needed', approvedState: 'denied' }));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('assertion_failed'));
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
  });

  it('checks every process node, including state changes, exceptions and terminal state', async () => {
    for (const node of ['process.entry', 'process.systems', 'process.preconditions', 'process.steps.0.action',
      'process.steps.0.stateChange', 'process.steps.1.action', 'process.steps.1.stateChange', 'process.exceptions', 'process.completion']) {
      const fixture = await setup('process');
      fixture.alter(report => ({ ...report, assertions: report.assertions.filter(entry => entry.node !== node) }));
      expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('insufficient_coverage'));
    }
  });

  it.each(['authorization', 'grant', 'version', 'source', 'target', 'checker', 'config', 'provider'])(
    'refuses promotion if %s changes during execution', async change => {
      const fixture = await setup();
      fixture.during(() => {
        if (change === 'authorization') fixture.deny();
        if (change === 'grant') fixture.changeGrant();
        if (change === 'version') fixture.store.transitionCandidate(fixture.candidate.id, 1, 'conflict');
        if (change === 'source') fixture.store.invalidateRequestSource(fixture.source.key);
        if (change === 'target') writeFileSync(fixture.oracle, '{}');
        if (change === 'checker') fixture.changeChecker();
        if (change === 'config') fixture.changeConfig();
        if (change === 'provider') Object.assign(fixture.provider.capabilities, { 'test-execution': false });
      });
      expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('blocked');
      expect(fixture.store.getCandidate(fixture.candidate.id)?.state).not.toBe('validated');
    });

  it('requires reconciliation before and after verification and observes its invalidation', async () => {
    const fixture = await setup();
    vi.mocked(fixture.deps.reconcile).mockImplementation(async () => {
      if (vi.mocked(fixture.deps.reconcile).mock.calls.length === 2) fixture.store.invalidateRequestSource(fixture.source.key);
      return { current: true, evidenceDigest: fixture.pack.digest };
    });
    expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('blocked');
    expect(fixture.deps.reconcile).toHaveBeenCalledTimes(2);
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).not.toBe('validated');
  });

  it('uses a fresh execution ID, rejects replay and permits only one concurrent CAS winner', async () => {
    const fixture = await setup();
    let previous: Report | undefined;
    fixture.alter(report => {
      if (!previous) { previous = structuredClone(report); return { ...report, assertions: [] }; }
      expect(report.binding.executionId).not.toBe(previous.binding.executionId);
      return previous;
    });
    expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('blocked');
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('binding_mismatch'));
    fixture.alter(report => report);
    const results = await Promise.all([validateLearningCandidate(fixture.input, fixture.deps), validateLearningCandidate(fixture.input, fixture.deps)]);
    expect(results.filter(result => result.status === 'validated')).toHaveLength(1);
    expect(results.filter(result => result.status === 'blocked')).toEqual([blocked('stale_candidate')]);
  });

  it('rejects wrong target scope and revoked authorization before execution', async () => {
    const fixture = await setup();
    fixture.wrongTargetScope();
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('target_mismatch'));
    fixture.deny();
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('unauthorized'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it('returns bounded errors without raw exceptions, reports or secrets', async () => {
    const fixture = await setup();
    vi.mocked(fixture.provider.verify).mockRejectedValueOnce(new Error('token=private-secret /private/home'));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('verification_failed'));
    vi.mocked(fixture.provider.verify).mockResolvedValueOnce({ passed: true, durationMs: 0, output: '密'.repeat(32 * 1024) });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('output_limit'));
  });

  it('honors pre-cancellation, cancellation during verify, and late success from an uncooperative provider', async () => {
    const fixture = await setup();
    const controller = new AbortController();
    controller.abort();
    expect(await validateLearningCandidate(fixture.input, fixture.deps, { signal: controller.signal })).toEqual(blocked('cancelled'));
    expect(fixture.deps.reconcile).not.toHaveBeenCalled();
    const active = new AbortController();
    fixture.during(() => { active.abort(); });
    expect(await validateLearningCandidate(fixture.input, fixture.deps, { signal: active.signal })).toEqual(blocked('cancelled'));
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
    fixture.during(undefined);
    let release!: () => void;
    fixture.during(() => new Promise<void>(resolve => { release = resolve; }));
    const stalled = new AbortController();
    const pending = validateLearningCandidate(fixture.input, fixture.deps, { signal: stalled.signal });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    stalled.abort();
    expect(await pending).toEqual(blocked('cancelled'));
    release();
    await new Promise(resolve => setImmediate(resolve));
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
  });

  it('times out even when the provider ignores abort', async () => {
    const fixture = await setup();
    vi.useFakeTimers();
    vi.mocked(fixture.provider.verify).mockImplementation(() => new Promise(() => {}));
    const pending = validateLearningCandidate(fixture.input, fixture.deps, { timeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toEqual(blocked('timed_out'));
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
  });

  it.each(['lesson', 'skill', 'tool'] as const)('explicitly blocks %s before selecting or running a checker', async kind => {
    const fixture = await setup('fact', true, true, proposal => {
      const cases = (['normal', 'recovery', 'refusal'] as const).map(kind => ({ kind, input: 'example', expected: 'verified' }));
      if (kind === 'lesson') return { ...proposal, kind, payload: { trigger: 'failure', rootCause: 'missing lock',
        rootCauseStatus: 'confirmed', attempts: [], fix: 'use lock', prevention: ['regression'] } };
      if (kind === 'skill') return { ...proposal, kind, payload: { newReason: 'no existing skill', triggers: ['review'],
        prohibitedConditions: [], inputs: [], branches: [], recovery: [], completion: 'reviewed', patch: 'review', evaluationCases: cases } };
      return { ...proposal, kind, payload: { existingTools: [], inputSchema: {}, outputSchema: {}, dependencies: [],
        permissions: [], timeoutMs: 1000, sideEffects: 'none', idempotency: 'read only', recovery: 'none', source: 'return input', tests: cases } };
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('unsupported_kind'));
    expect(fixture.deps.resolveChecker).not.toHaveBeenCalled();
    expect(fixture.provider.verify).not.toHaveBeenCalled();
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
  });

  it.each(['gap', 'duplicate-step', 'proposal'] as const)('blocks candidate evidence deficiency: %s', async deficiency => {
    const fixture = await setup(deficiency === 'proposal' ? 'fact' : 'process', true, true, proposal => {
      if (proposal.kind === 'fact') proposal.payload.classification = 'proposal';
      if (proposal.kind === 'process' && deficiency === 'gap') {
        proposal.payload.steps[0].evidenceIds = [];
        proposal.payload.steps[0].missingEvidence = 'No observation';
      }
      if (proposal.kind === 'process' && deficiency === 'duplicate-step') proposal.payload.steps[1].id = proposal.payload.steps[0].id;
      return proposal;
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('insufficient_evidence'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it('preserves large Unicode and whitespace assertions losslessly in bounded receipt chunks', async () => {
    const rule = '观察🙂 '.repeat(300).trim();
    const fixture = await setup('fact', true, true, proposal => {
      if (proposal.kind === 'fact') proposal.payload.rule = rule;
      return proposal;
    });
    const policy = JSON.parse(readFileSync(fixture.oracle, 'utf8'));
    writeFileSync(fixture.oracle, JSON.stringify({ ...policy, rule }));
    expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('validated');
    const receipt = fixture.store.getValidation(fixture.candidate.id)!;
    expect(receipt.results.length).toBeLessThanOrEqual(32);
    expect(receipt.results.every(chunk => chunk.startsWith('json-base64-v1:') && chunk.length <= 2048)).toBe(true);
    const audit = JSON.parse(Buffer.from(receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString('utf8'));
    expect(audit.report.assertions.find((entry: Assertion) => entry.node === 'fact.rule').actual).toBe(rule);
    expect(audit.receiptDigest).toBe(hash(audit.report));
  });

  it('does not accept arbitrary host execution mode through trusted checker configuration', async () => {
    const fixture = await setup();
    const checker = await fixture.deps.resolveChecker(fixture.candidate, fixture.input.checkerId, {});
    vi.mocked(fixture.deps.resolveChecker).mockResolvedValueOnce({ ...checker!, mode: 'host-exec' } as unknown as LearningValidationChecker);
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('checker_unavailable'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it.each(['reconcile', 'authorize', 'resolveChecker'] as const)('requires the %s dependency and sanitizes its errors', async callback => {
    const fixture = await setup();
    vi.mocked(fixture.deps[callback]).mockRejectedValueOnce(new Error('private-token'));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked(
      callback === 'reconcile' ? 'source_unavailable' : callback === 'authorize' ? 'unauthorized' : 'checker_unavailable'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it('honors cancellation during final authorization and never records a late valid report', async () => {
    const fixture = await setup();
    const controller = new AbortController();
    vi.mocked(fixture.deps.authorize).mockImplementation(async () => {
      if (vi.mocked(fixture.deps.authorize).mock.calls.length === 2) controller.abort();
      return { allowed: true, authorizationDigest: hash('grant-1') };
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps, { signal: controller.signal })).toEqual(blocked('cancelled'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('rechecks candidate and source after the final asynchronous resolver', async () => {
    const fixture = await setup();
    const resolve = vi.mocked(fixture.deps.resolveChecker).getMockImplementation()!;
    vi.mocked(fixture.deps.resolveChecker).mockImplementationOnce(resolve).mockImplementationOnce(async (...args) => {
      fixture.store.invalidateRequestSource(fixture.source.key);
      return resolve(...args);
    });
    expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('blocked');
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it.each(['ref', 'revision', 'snapshotDigest', 'scope'])('rejects a correctly shaped receipt for the wrong target %s', async key => {
    const fixture = await setup();
    fixture.alter(report => ({ ...report, binding: { ...report.binding,
      target: { ...(report.binding.target as object), [key]: key === 'snapshotDigest' ? 'a'.repeat(64) : key === 'scope' ? 'github:other/api' : 'different' } } }));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('binding_mismatch'));
  });

  it('checks the authority assertion against actual trusted policy data', async () => {
    const fixture = await setup();
    const policy = JSON.parse(readFileSync(fixture.oracle, 'utf8'));
    writeFileSync(fixture.oracle, JSON.stringify({ ...policy, authority: ['unrelated-source'] }));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('assertion_failed'));
  });

  it('still rechecks guards after a provider failure or a malformed report', async () => {
    for (const fails of [true, false]) {
      const fixture = await setup();
      if (fails) vi.mocked(fixture.provider.verify).mockRejectedValueOnce(new Error('private-token'));
      else vi.mocked(fixture.provider.verify).mockResolvedValueOnce({ passed: true, durationMs: 0, output: 'exit 0' });
      expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('blocked');
      expect(fixture.deps.reconcile).toHaveBeenCalledTimes(2);
      expect(fixture.deps.authorize).toHaveBeenCalledTimes(2);
      expect(fixture.deps.resolveChecker).toHaveBeenCalledTimes(2);
    }
  });

  it('requires literal provider success in addition to semantic proof', async () => {
    const fixture = await setup();
    const verify = vi.mocked(fixture.provider.verify).getMockImplementation()!;
    vi.mocked(fixture.provider.verify).mockImplementationOnce(async (...args) => ({ ...await verify(...args), passed: false }));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('verification_failed'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('checks authorization before reconciling or loading private source evidence', async () => {
    const fixture = await setup();
    fixture.deny();
    const read = vi.spyOn(fixture.store, 'getEvidencePack');
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('unauthorized'));
    expect(read).not.toHaveBeenCalled();
    expect(fixture.deps.reconcile).not.toHaveBeenCalled();
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it.each(['absent', 'not-current', 'wrong-digest'])('requires a positive source reconciliation attestation: %s', async defect => {
    const fixture = await setup();
    vi.mocked(fixture.deps.reconcile).mockResolvedValueOnce(defect === 'absent' ? undefined as never
      : { current: defect !== 'not-current', evidenceDigest: defect === 'wrong-digest' ? '0'.repeat(64) : fixture.pack.digest });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('source_unavailable'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it.each(['missing', 'changed'])('detects a %s real source without relying on a store invalidation side effect', async defect => {
    const fixture = await setup();
    fixture.during(() => {
      if (defect === 'missing') rmSync(fixture.sourcePath);
      else writeFileSync(fixture.sourcePath, 'tampered source');
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('source_unavailable'));
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it.each(['absent', 'negative', 'generic', 'duplicate', 'throws'])('requires explicit semantic protocol support in provider doctor: %s', async defect => {
    const fixture = await setup();
    if (defect === 'absent') fixture.provider.doctor = undefined;
    if (defect === 'negative') vi.mocked(fixture.provider.doctor!).mockResolvedValue([{ check: 'learning-validation-v1', ok: false }]);
    if (defect === 'generic') vi.mocked(fixture.provider.doctor!).mockResolvedValue([{ check: 'test-execution', ok: true }]);
    if (defect === 'duplicate') vi.mocked(fixture.provider.doctor!).mockResolvedValue([{ check: 'learning-validation-v1', ok: false }, { check: 'learning-validation-v1', ok: true }]);
    if (defect === 'throws') vi.mocked(fixture.provider.doctor!).mockRejectedValue(new Error('private-token'));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('checker_unavailable'));
    expect(fixture.provider.verify).not.toHaveBeenCalled();
  });

  it('blocks the existing ordinary test-runner before it can interpret the JSON target as a host cwd', async () => {
    const fixture = await setup();
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: 'passed', stderr: '' }));
    const ordinary = new TestRunnerVerificationProvider({ runner });
    const verify = vi.spyOn(ordinary, 'verify');
    const checker = (await fixture.deps.resolveChecker(fixture.candidate, fixture.input.checkerId, {}))!;
    vi.mocked(fixture.deps.resolveChecker).mockResolvedValue({ ...checker, provider: ordinary });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('checker_unavailable'));
    expect(verify).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
  });

  it('rechecks semantic protocol support after execution', async () => {
    const fixture = await setup();
    fixture.during(() => { vi.mocked(fixture.provider.doctor!).mockResolvedValue([{ check: 'learning-validation-v1', ok: false }]); });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('checker_unavailable'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it.each(['source', 'grant', 'target'] as const)('rejects an external %s file change while final doctor awaits', async change => {
    const fixture = await setup();
    let ready!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(fixture.provider.doctor!).mockImplementation(async () => {
      if (vi.mocked(fixture.provider.doctor!).mock.calls.length === 2) { ready(); await gate; }
      return [{ check: 'learning-validation-v1', ok: true }];
    });
    const pending = validateLearningCandidate(fixture.input, fixture.deps);
    await started;
    if (change === 'source') writeFileSync(fixture.sourcePath, 'externally changed source');
    if (change === 'grant') fixture.deny();
    if (change === 'target') writeFileSync(fixture.oracle, '{}');
    release();
    expect((await pending).status).toBe('blocked');
    expect(fixture.deps.readCommitSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('candidate');
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it.each(['revoke', 'grant', 'source', 'target', 'checker', 'config'] as const)('blocks final doctor drift of %s at the synchronous commit gate', async change => {
    const fixture = await setup();
    vi.mocked(fixture.provider.doctor!).mockImplementation(async () => {
      if (vi.mocked(fixture.provider.doctor!).mock.calls.length === 2) {
        if (change === 'revoke') fixture.deny();
        if (change === 'grant') fixture.changeGrant();
        if (change === 'source') writeFileSync(fixture.sourcePath, 'changed source');
        if (change === 'target') writeFileSync(fixture.oracle, '{}');
        if (change === 'checker') fixture.changeChecker();
        if (change === 'config') fixture.changeConfig();
      }
      return [{ check: 'learning-validation-v1', ok: true }];
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked(
      change === 'revoke' ? 'unauthorized' : change === 'grant' ? 'authorization_changed'
        : change === 'source' ? 'source_unavailable' : change === 'target' ? 'target_mismatch' : 'checker_changed'));
    expect(fixture.deps.readCommitSnapshot).toHaveBeenCalledTimes(1);
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it.each(['revoke', 'source'] as const)('blocks final resolver drift of %s at the synchronous commit gate', async change => {
    const fixture = await setup();
    const resolve = vi.mocked(fixture.deps.resolveChecker).getMockImplementation()!;
    vi.mocked(fixture.deps.resolveChecker).mockImplementation(async (...args) => {
      const selected = await resolve(...args);
      if (vi.mocked(fixture.deps.resolveChecker).mock.calls.length === 2) {
        if (change === 'revoke') fixture.deny();
        else writeFileSync(fixture.sourcePath, 'changed source');
      }
      return selected;
    });
    expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('blocked');
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('enforces a monotonic deadline after final doctor blocks the event loop', async () => {
    const fixture = await setup();
    vi.mocked(fixture.provider.doctor!).mockImplementation(async () => {
      if (vi.mocked(fixture.provider.doctor!).mock.calls.length === 2) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return [{ check: 'learning-validation-v1', ok: true }];
    });
    const started = performance.now();
    expect(await validateLearningCandidate(fixture.input, fixture.deps, { timeoutMs: 30 })).toEqual(blocked('timed_out'));
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('enforces the deadline after the synchronous commit snapshot itself blocks', async () => {
    const fixture = await setup();
    const read = vi.mocked(fixture.deps.readCommitSnapshot).getMockImplementation()!;
    vi.mocked(fixture.deps.readCommitSnapshot).mockImplementation((...args) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      return read(...args);
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps, { timeoutMs: 30 })).toEqual(blocked('timed_out'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it.each(['absent', 'async', 'throws', 'invalid'] as const)('requires a synchronous commit snapshot with no fallback: %s', async defect => {
    const fixture = await setup();
    if (defect === 'absent') Object.assign(fixture.deps, { readCommitSnapshot: undefined });
    if (defect === 'async') {
      const read = vi.mocked(fixture.deps.readCommitSnapshot).getMockImplementation()!;
      Object.assign(fixture.deps, { readCommitSnapshot: async (...args: Parameters<typeof read>) => read(...args) });
    }
    if (defect === 'throws') vi.mocked(fixture.deps.readCommitSnapshot).mockImplementation(() => { throw new Error('private-token'); });
    if (defect === 'invalid') vi.mocked(fixture.deps.readCommitSnapshot).mockReturnValue({} as never);
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('commit_guard_unavailable'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('does not yield between the commit snapshot and the guarded store write', async () => {
    const fixture = await setup();
    const read = vi.mocked(fixture.deps.readCommitSnapshot).getMockImplementation()!;
    const record = vi.spyOn(fixture.store, 'recordValidation');
    vi.mocked(fixture.deps.readCommitSnapshot).mockImplementation((...args) => {
      const current = read(...args);
      queueMicrotask(() => { expect(record).toHaveBeenCalledTimes(1); });
      return current;
    });
    expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('validated');
    expect(fixture.deps.readCommitSnapshot).toHaveBeenCalledTimes(1);
  });

  it('permits one CAS winner across independent SQLite handles with the mandatory commit snapshot', async () => {
    const fixture = await setup();
    const second = new CandidateStore({ file: join(fixture.oracle, '..', 'private', 'ledger.sqlite') });
    resources.push(() => second.close());
    const results = await Promise.all([validateLearningCandidate(fixture.input, fixture.deps),
      validateLearningCandidate(fixture.input, { ...fixture.deps, store: second })]);
    expect(results.filter(result => result.status === 'validated')).toHaveLength(1);
    expect(results.filter(result => result.status === 'blocked')).toEqual([blocked('stale_candidate')]);
    expect(fixture.store.getCandidate(fixture.candidate.id)?.version).toBe(2);
    expect(fixture.store.getValidation(fixture.candidate.id)).toEqual(second.getValidation(fixture.candidate.id));
  });

  it('rolls back validation when a real SQLite writer delays transaction admission beyond the deadline', async () => {
    const fixture = await setup();
    const file = join(fixture.oracle, '..', 'private', 'ledger.sqlite');
    const coordination = new SharedArrayBuffer(8);
    const state = new Int32Array(coordination);
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const database = new DatabaseSync(workerData.file);
      const state = new Int32Array(workerData.coordination);
      parentPort.postMessage('ready');
      Atomics.wait(state, 0, 0);
      database.exec('BEGIN IMMEDIATE');
      Atomics.store(state, 1, 1);
      Atomics.notify(state, 1);
      Atomics.wait(state, 0, 1, 250);
      database.exec('COMMIT');
      database.close();
    `, { eval: true, workerData: { file, coordination } });
    resources.push(() => { void worker.terminate(); });
    await new Promise<void>((resolve, reject) => { worker.once('message', () => resolve()); worker.once('error', reject); });
    let lockedAt = 0;
    vi.mocked(fixture.provider.doctor!).mockImplementation(async () => {
      if (vi.mocked(fixture.provider.doctor!).mock.calls.length === 2) {
        Atomics.store(state, 0, 1);
        Atomics.notify(state, 0);
        if (Atomics.wait(state, 1, 0, 1000) === 'timed-out') throw new Error('writer lock not acquired');
        lockedAt = performance.now();
      }
      return [{ check: 'learning-validation-v1', ok: true }];
    });
    const record = vi.spyOn(fixture.store, 'recordValidation');
    const startedAt = performance.now();
    const result = await validateLearningCandidate(fixture.input, fixture.deps, { timeoutMs: 100 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(lockedAt - startedAt).toBeGreaterThan(0);
    expect(lockedAt - startedAt).toBeLessThan(100);
    expect(performance.now() - startedAt).toBeGreaterThan(200);
    expect(result).toEqual(blocked('timed_out'));
    expect(fixture.store.getCandidate(fixture.candidate.id)).toEqual(fixture.candidate);
    expect(fixture.store.getCandidateVersions(fixture.candidate.id)).toHaveLength(1);
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
    const reopened = new CandidateStore({ file });
    resources.push(() => reopened.close());
    expect(reopened.getCandidate(fixture.candidate.id)).toEqual(fixture.candidate);
    expect(reopened.getValidation(fixture.candidate.id)).toBeUndefined();
  });
});
