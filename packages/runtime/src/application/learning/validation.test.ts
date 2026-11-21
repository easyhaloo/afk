import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Worker } from 'node:worker_threads';
import type { RunEventData } from '@afk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { TestRunnerVerificationProvider } from '../../infrastructure/verification/index.js';
import type { VerificationProvider, VerificationRequest } from '../../plugin-sdk/capabilities.js';
import { CandidateStore } from './candidate-store.js';
import { completeFixtureRequest } from './ledger-data.fixture.spec.js';
import type { CandidateProposal } from './contracts.js';
import { buildEvidencePack } from './evidence.js';
import { canonicalLearningJson } from './requests.js';
import type { LessonQaConfiguration } from './lesson-validation.js';
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
  qa?: unknown;
}; assertions: Assertion[] };

async function setup(kind: 'fact' | 'process' = 'fact', snapshot = true, observed = true,
  transform: (proposal: CandidateProposal) => CandidateProposal = proposal => proposal, sourceEvents: RunEventData[] = [], analysisCallId?: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'learning-validation-'));
  resources.push(() => rmSync(root, { recursive: true, force: true }));
  const store = new CandidateStore({ file: join(root, 'private', 'ledger.sqlite') });
  resources.push(() => store.close());
  const events = new JsonlEventStore({ root });
  await events.append([{ id: 'event-1', schemaVersion: 1, type: 'agent.session_recorded',
    occurredAt: '2026-11-09T00:00:00Z', context: { runId: 'run-1', traceId: 'trace-1', workItemId: `${scope}#1`,
      profileId: 'profile-1', attempt: 1, actor: { kind: 'system', id: 'fixture' } }, correlationId: 'run-1',
    data: { kind: 'agent.session_recorded', sessionId: 'session-1' } }]);
  if (sourceEvents.length) await events.append(sourceEvents.map((data, index) => ({ id: `source-${index}`, schemaVersion: 1 as const,
    type: data.kind, occurredAt: '2026-11-09T00:00:01Z', context: { runId: 'run-1', traceId: 'trace-1', workItemId: `${scope}#1`,
      profileId: 'profile-1', attempt: 1, actor: { kind: 'system' as const, id: 'fixture' } }, correlationId: 'run-1', data })));
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
  const source = store.submitRequest({ request: { version: 1, scope, sourceId: 'run:run-1', sourceRunId: 'run-1', workItemId: `${scope}#1`,
    evidenceDigest: pack.digest, analyzerVersion: 'fixture-1', reason: 'completed' }, evidence: refs }, snapshot ? pack : undefined);
  const processed = completeFixtureRequest(store, source.key, { version: 1, candidates: [proposal], warnings: [] }, analysisCallId);
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
      'process.applicability.preconditions': [], 'process.applicability.exclusions': [], 'process.applicability.invalidationConditions': [],
      'process.stepCount': String(policy.actions.length),
      'process.exceptions': [`denied -> ${perform('draft', 'approve', false)}`] };
    policy.actions.forEach((action: string, index: number) => {
      const previous = state;
      state = perform(state, action, true);
      actual[`process.steps.${index}.action`] = action;
      actual[`process.steps.${index}.stateChange`] = `${previous} -> ${state}`;
    });
    for (const [field, value] of Object.entries(policy.lesson ?? {})) actual[`lesson.${field}`] = value as string | string[];
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

async function ownedNativeFactFixture() {
  const fixture = await setup();
  const command = [realpathSync(process.execPath), '-e', `
    const { readFileSync } = require('node:fs'); let input = '';
    process.stdin.on('data', chunk => input += chunk).on('end', () => {
      const request = JSON.parse(input), policy = JSON.parse(readFileSync('policy.json', 'utf8'));
      const actual = { 'fact.subject': policy.subject, 'fact.rule': policy.rule, 'fact.authority': policy.authority };
      process.stdout.write(JSON.stringify({ protocol: request.protocol, binding: request.binding,
        assertions: request.assertions.map(assertion => ({ ...assertion, actual: actual[assertion.node], status: 'observed' })) }));
    });
  `];
  const execution = { protocol: 'learning-fact-command-v1' as const, command, cwd: dirname(fixture.oracle),
    workspaceDigest: hash('owned-fixture-workspace'), workspaceRevision: 'owned-fixture-revision', leaseId: 'owned-fixture-lease' };
  const native = new TestRunnerVerificationProvider({ command });
  const verify = vi.fn(native.verify.bind(native));
  fixture.provider.verify = verify;
  const resolveChecker = fixture.deps.resolveChecker;
  fixture.deps.resolveChecker = async (...args) => ({ ...(await resolveChecker(...args))!, execution });
  const read = fixture.deps.readCommitSnapshot;
  fixture.deps.readCommitSnapshot = (...args) => { const snapshot = read(...args); return { ...snapshot, checker: { ...snapshot.checker, execution } }; };
  const completeExecution = vi.fn(async () => ({ closed: true as const }));
  fixture.deps.completeExecution = completeExecution;
  return { ...fixture, execution, verify, completeExecution };
}

describe('native fact receipt binding using owned fixtures', () => {
  it.each(['missing', 'replay', 'padded-id', 'cwd', 'command', 'input', 'exit', 'closed', 'stdout'] as const)('rejects %s observation even when outer passed is true', async defect => {
    const fixture = await ownedNativeFactFixture();
    const run = fixture.verify.getMockImplementation()!;
    fixture.verify.mockImplementation(async (...args) => {
      const result = await run(...args);
      const observation = result.execution!;
      if (defect === 'missing') return { ...result, execution: undefined };
      return { ...result, execution: { ...observation,
        ...(defect === 'replay' ? { executionId: 'previous-execution' } : {}),
        ...(defect === 'padded-id' ? { executionId: ` ${observation.executionId} ` } : {}),
        ...(defect === 'cwd' ? { cwd: dirname(observation.cwd) } : {}),
        ...(defect === 'command' ? { command: [observation.command[0], '-e', 'process.exit(0)'] } : {}),
        ...(defect === 'input' ? { inputDigest: 'a'.repeat(64) } : {}),
        ...(defect === 'exit' ? { exitCode: 1 } : {}),
        ...(defect === 'closed' ? { closed: false as never } : {}),
        ...(defect === 'stdout' ? { stdout: '{}' } : {}) } };
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked(defect === 'stdout' ? 'invalid_receipt' : 'invalid_execution'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('requires cleanup before entering the synchronous ledger guard', async () => {
    const fixture = await ownedNativeFactFixture();
    fixture.completeExecution.mockRejectedValue(new Error('owned fixture cleanup failed'));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('cleanup_failed'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });
});

async function lessonFixture(repair = false, analysisCallId?: string) {
  const payload = { trigger: 'duplicate retry', rootCause: 'check then write race', rootCauseStatus: 'confirmed' as const,
    attempts: ['retry failed'], fix: 'Serialize read and write', prevention: ['Run competing retry regression'] };
  const fixture = await setup('fact', true, true, proposal => ({ ...proposal, kind: 'lesson', payload }), repair
    ? [{ kind: 'qa.failed', reason: 'Competing retries duplicated publication' }, { kind: 'run.finished', outcome: 'failed' }] : [], analysisCallId);
  const events = new JsonlEventStore({ root: join(dirname(fixture.oracle), 'qa') });
  const revision = 'a'.repeat(40);
  const qa: LessonQaConfiguration = { scope, workItemId: `${scope}#1`, runId: 'independent-qa', targetRevision: revision,
    root: events.root, auditDigest: '' };
  await events.append([{ kind: 'qa.started' as const }, { kind: 'decision.made' as const, command: 'experience.qa-target', accepted: true,
    reason: JSON.stringify({ target: { project: scope, revision, dirty: false } }) },
  { kind: 'commit.recorded' as const, phase: 'qa' as const, commitSha: revision, branch: 'qa' }, { kind: 'qa.passed' as const },
  { kind: 'run.finished' as const, outcome: 'succeeded' as const }].map((data, index) => ({ id: `qa-${index}`,
    schemaVersion: 1 as const, type: data.kind, occurredAt: '2026-11-11T00:00:00Z', context: { runId: qa.runId,
      traceId: qa.runId, workItemId: qa.workItemId, profileId: 'qa', attempt: 1, actor: { kind: 'system' as const, id: 'fixture' } },
    correlationId: qa.runId, data })));
  const qaPath = events.pathFor(qa.runId);
  qa.auditDigest = createHash('sha256').update(readFileSync(qaPath)).digest('hex');
  if (repair) {
    const fix = new JsonlEventStore({ root: join(dirname(fixture.oracle), 'fix') });
    const fixRunId = 'repair-fix';
    await fix.append([{ kind: 'commit.recorded' as const, phase: 'implementation' as const, commitSha: revision, branch: 'repair' },
      { kind: 'run.finished' as const, outcome: 'succeeded' as const }].map((data, index) => ({ id: `fix-${index}`,
      schemaVersion: 1 as const, type: data.kind, occurredAt: '2026-11-10T00:00:00Z', context: { runId: fixRunId,
        traceId: fixRunId, workItemId: qa.workItemId, profileId: 'fix', attempt: 1, actor: { kind: 'system' as const, id: 'fixture' } },
      correlationId: fixRunId, data })));
    qa.repair = { failure: { runId: fixture.source.request.sourceRunId!, root: dirname(fixture.sourcePath),
      auditDigest: createHash('sha256').update(readFileSync(fixture.sourcePath)).digest('hex') },
    fix: { runId: fixRunId, root: fix.root, auditDigest: createHash('sha256').update(readFileSync(fix.pathFor(fixRunId))).digest('hex') } };
  }
  writeFileSync(fixture.oracle, JSON.stringify({ ...JSON.parse(readFileSync(fixture.oracle, 'utf8')),
    lesson: { ...payload, project: scope, environments: [], versions: [], applicabilityPreconditions: [], exclusions: [],
      invalidationConditions: [], fixTargetRevision: revision } }));
  const resolveChecker = fixture.deps.resolveChecker;
  fixture.deps.resolveChecker = async (...args) => ({ ...(await resolveChecker(...args))!, qa: structuredClone(qa) });
  const readCommitSnapshot = fixture.deps.readCommitSnapshot;
  fixture.deps.readCommitSnapshot = (...args) => {
    const snapshot = readCommitSnapshot(...args);
    return { ...snapshot, checker: { ...snapshot.checker, qa: structuredClone(qa) },
      qaAuditDigest: createHash('sha256').update(readFileSync(qaPath)).digest('hex'),
      ...(qa.repair ? { repairAuditDigests: {
        failure: createHash('sha256').update(readFileSync(fixture.sourcePath)).digest('hex'),
        fix: createHash('sha256').update(readFileSync(new JsonlEventStore({ root: qa.repair.fix.root }).pathFor(qa.repair.fix.runId))).digest('hex'),
      } } : {}) };
  };
  return { ...fixture, qa, qaPath };
}

describe('validateLearningCandidate production boundary', () => {
  it.each(['analysisRunId', 'sessionId', 'distinct'] as const)('rechecks late analysis identity under the validation write lock: %s', async field => {
    const callId = 'pending-analysis';
    const fixture = await lessonFixture(false, callId);
    const recordValidation = fixture.store.recordValidation.bind(fixture.store);
    vi.spyOn(fixture.store, 'recordValidation').mockImplementation((...args) => {
      fixture.store.recordAnalysisIdentity(callId, {
        analysisRunId: field === 'analysisRunId' ? fixture.qa.runId : 'separate-analysis',
        sessionId: field === 'sessionId' ? fixture.qa.runId : 'separate-session',
      });
      return recordValidation(...args);
    });
    const result = await validateLearningCandidate(fixture.input, fixture.deps);
    expect(fixture.provider.verify).toHaveBeenCalledOnce();
    if (field === 'distinct') {
      expect(result.status).toBe('validated');
      expect(fixture.store.getCandidate(fixture.candidate.id)?.version).toBe(2);
    } else {
      expect(result).toEqual(blocked('qa_not_independent'));
      expect(fixture.store.getCandidate(fixture.candidate.id)?.version).toBe(1);
      expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
    }
  });

  it('binds actual QA evidence to the lesson semantic receipt without confusing the oracle revision', async () => {
    const fixture = await lessonFixture();
    expect((await validateLearningCandidate(fixture.input, fixture.deps)).status).toBe('validated');
    const envelope = JSON.parse(fixture.requests[0].target);
    expect(envelope.binding.qa).toMatchObject({ targetRevision: fixture.qa.targetRevision, auditDigest: fixture.qa.auditDigest });
    expect(envelope.binding.target.revision).toBe('revision-1');
    expect(envelope.binding.qaEvidence).toHaveLength(5);
    const fix = envelope.assertions.find((entry: Assertion) => entry.node === 'lesson.fix');
    expect(fix.evidence).toHaveLength(fixture.candidate.proposal.evidenceIds.length + 5);
  });

  it.each(['missing', 'changed', 'unreadable'] as const)('requires a synchronous commit-time QA digest: %s', async mode => {
    const fixture = await lessonFixture();
    const readCommitSnapshot = fixture.deps.readCommitSnapshot;
    fixture.deps.readCommitSnapshot = (...args) => {
      if (mode === 'unreadable') throw new Error(fixture.qaPath);
      return { ...readCommitSnapshot(...args), qaAuditDigest: mode === 'missing' ? undefined : '0'.repeat(64) };
    };
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked(mode === 'unreadable' ? 'commit_guard_unavailable' : 'audit_changed'));
    expect(fixture.store.getCandidate(fixture.candidate.id)?.version).toBe(1);
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it.each(['failure', 'fix', 'matching'] as const)('guards repair audit digests after the checker returns and before validation commits: %s', async mode => {
    const fixture = await lessonFixture(true);
    const repair = fixture.qa.repair!;
    const fixStore = new JsonlEventStore({ root: repair.fix.root });
    const fixPath = fixStore.pathFor(repair.fix.runId);
    const fixPack = await buildEvidencePack({ sources: [{ id: 'lesson-fix', kind: 'audit', path: fixPath,
      allowedRoot: repair.fix.root, runId: repair.fix.runId, expectedDigest: repair.fix.auditDigest }] });
    const failureEvents = fixture.pack.entries.map(entry => JSON.parse(entry.content));
    const fixEvents = fixPack.entries.map(entry => JSON.parse(entry.content));
    const failureRef = fixture.pack.entries.find(entry => JSON.parse(entry.content).id === 'source-0')!.ref;
    const repairEvidence = [failureRef, ...fixPack.entries.map(entry => entry.ref)];
    let changed: { path: string; bytes: Buffer; role: 'failure' | 'fix' } | undefined;
    if (mode !== 'matching') {
      const pin = repair[mode];
      const events = new JsonlEventStore({ root: pin.root });
      const path = events.pathFor(pin.runId);
      const original = readFileSync(path);
      await events.append([{ id: `${mode}-late-note`, schemaVersion: 1, type: 'decision.made',
        occurredAt: '2026-11-12T00:00:00Z', context: { runId: pin.runId, traceId: pin.runId,
          workItemId: fixture.qa.workItemId, profileId: mode, attempt: 1, actor: { kind: 'system', id: 'fixture' } },
        correlationId: pin.runId, data: { kind: 'decision.made', command: 'repair.audit-note', accepted: true } }]);
      changed = { path, bytes: readFileSync(path), role: mode };
      writeFileSync(path, original);
    }
    const phases: string[] = [];
    const verify = fixture.provider.verify.bind(fixture.provider);
    fixture.provider.verify = vi.fn(async (...args) => {
      const result = await verify(...args);
      phases.push('checker-returned');
      return result;
    });
    const readCommitSnapshot = fixture.deps.readCommitSnapshot;
    const commitRead = vi.fn((...args: Parameters<typeof readCommitSnapshot>) => {
      phases.push('commit-snapshot');
      const snapshot = readCommitSnapshot(...args);
      if (!changed) return snapshot;
      writeFileSync(changed.path, changed.bytes);
      return { ...snapshot, repairAuditDigests: { ...snapshot.repairAuditDigests!,
        [changed.role]: createHash('sha256').update(readFileSync(changed.path)).digest('hex') } };
    });
    fixture.deps.readCommitSnapshot = commitRead;

    const result = await validateLearningCandidate(fixture.input, fixture.deps);

    expect(fixture.provider.verify).toHaveBeenCalledOnce();
    expect(phases).toEqual(['checker-returned', 'commit-snapshot']);
    expect(commitRead).toHaveBeenCalledOnce();
    expect(commitRead.mock.results[0].value).toMatchObject({ source: { current: true }, qaAuditDigest: fixture.qa.auditDigest });
    const envelope = JSON.parse(fixture.requests[0].target);
    expect(envelope.binding.repair).toEqual({
      failure: { runId: repair.failure.runId, auditDigest: repair.failure.auditDigest,
        auditHead: failureEvents.at(-1).integrity.hash, auditSequence: failureEvents.at(-1).sequence },
      fix: { runId: repair.fix.runId, auditDigest: repair.fix.auditDigest,
        auditHead: fixEvents.at(-1).integrity.hash, auditSequence: fixEvents.at(-1).sequence },
      failureEventId: 'source-0', fixCommitEventId: 'fix-0', fixCompletionEventId: 'fix-1',
    });
    expect(envelope.binding.qa).toMatchObject({ qaRunId: fixture.qa.runId, targetRevision: fixture.qa.targetRevision });
    expect(new Set([repair.failure.runId, repair.fix.runId, fixture.qa.runId]).size).toBe(3);
    expect(envelope.binding.repairEvidence).toEqual(repairEvidence);
    for (const node of ['lesson.fix', 'lesson.prevention', 'lesson.fixTargetRevision']) {
      expect(envelope.assertions.find((entry: Assertion) => entry.node === node).evidence).toEqual(expect.arrayContaining(
        repairEvidence.map(({ id, digest, locator }) => ({ id, digest, locator }))));
    }
    if (mode === 'matching') {
      expect(result).toMatchObject({ status: 'validated', candidateVersion: 1, validatedVersion: 2 });
      expect(fixture.store.getCandidate(fixture.candidate.id)).toMatchObject({ state: 'validated', version: 2 });
      const receipt = fixture.store.getValidation(fixture.candidate.id)!;
      const audit = JSON.parse(Buffer.from(receipt.results.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64').toString('utf8'));
      expect(audit.report.binding).toEqual(envelope.binding);
    } else {
      expect(commitRead.mock.results[0].value.repairAuditDigests[mode]).not.toBe(repair[mode].auditDigest);
      expect(result).toEqual(blocked('audit_changed'));
      expect(fixture.store.getCandidate(fixture.candidate.id)).toEqual(fixture.candidate);
      expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
    }
  });

  it('rejects a semantic report that substitutes the oracle revision for the QA Git revision', async () => {
    const fixture = await lessonFixture();
    fixture.alter(report => ({ ...report, binding: { ...report.binding, qa: { targetRevision: 'revision-1' } } }));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('binding_mismatch'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it.each(['missing-root-cause', 'missing-qa-evidence'] as const)('requires lesson semantic coverage: %s', async defect => {
    const fixture = await lessonFixture();
    fixture.alter(report => ({ ...report, assertions: defect === 'missing-root-cause'
      ? report.assertions.filter(assertion => assertion.node !== 'lesson.rootCause')
      : report.assertions.map(assertion => assertion.node === 'lesson.fix' ? { ...assertion, evidence: assertion.evidence.slice(0, 1) } : assertion) }));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked(defect === 'missing-root-cause'
      ? 'insufficient_coverage' : 'insufficient_evidence'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

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

  it('rejects a missing final action even when it does not change the terminal state', async () => {
    const fixture = await setup('process');
    const policy = JSON.parse(readFileSync(fixture.oracle, 'utf8'));
    policy.actions.push('archive-receipt');
    writeFileSync(fixture.oracle, JSON.stringify(policy));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('assertion_failed'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('checks every process node, including state changes, exceptions and terminal state', async () => {
    for (const node of ['process.applicability.preconditions', 'process.applicability.exclusions', 'process.applicability.invalidationConditions',
      'process.entry', 'process.systems', 'process.preconditions', 'process.stepCount', 'process.steps.0.action',
      'process.steps.0.stateChange', 'process.steps.1.action', 'process.steps.1.stateChange', 'process.exceptions', 'process.completion']) {
      const fixture = await setup('process');
      fixture.alter(report => ({ ...report, assertions: report.assertions.filter(entry => entry.node !== node) }));
      expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('insufficient_coverage'));
    }
  });

  it('rejects a narrative prerequisite incorrectly copied into machine routing conditions', async () => {
    const fixture = await setup('process', true, true, proposal => ({ ...proposal,
      applicability: { ...proposal.applicability, preconditions: ['authenticated'] } }));
    expect(await validateLearningCandidate(fixture.input, fixture.deps)).toEqual(blocked('assertion_failed'));
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
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

  it.each(['skill', 'tool'] as const)('explicitly blocks %s before selecting or running a checker', async kind => {
    const fixture = await setup('fact', true, true, proposal => {
      const cases = (['normal', 'recovery', 'refusal'] as const).map(kind => ({ kind, input: 'example', expected: 'verified' }));
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
      target: { ...report.binding.target, [key]: key === 'snapshotDigest' ? 'a'.repeat(64) : key === 'scope' ? 'github:other/api' : 'different' } } }));
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

  it('enforces a monotonic deadline when the final doctor reaches it before the timer fires', async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    resources.push(() => clock.mockRestore());
    vi.mocked(fixture.provider.doctor!).mockImplementation(async () => {
      if (vi.mocked(fixture.provider.doctor!).mock.calls.length === 2) clock.mockReturnValue(30);
      return [{ check: 'learning-validation-v1', ok: true }];
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps, { timeoutMs: 30 })).toEqual(blocked('timed_out'));
    expect(fixture.provider.doctor).toHaveBeenCalledTimes(2);
    expect(fixture.store.getValidation(fixture.candidate.id)).toBeUndefined();
  });

  it('enforces the deadline reached during the synchronous commit snapshot', async () => {
    const fixture = await setup();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    resources.push(() => clock.mockRestore());
    const read = vi.mocked(fixture.deps.readCommitSnapshot).getMockImplementation()!;
    vi.mocked(fixture.deps.readCommitSnapshot).mockImplementation((...args) => {
      clock.mockReturnValue(30);
      return read(...args);
    });
    expect(await validateLearningCandidate(fixture.input, fixture.deps, { timeoutMs: 30 })).toEqual(blocked('timed_out'));
    expect(fixture.deps.readCommitSnapshot).toHaveBeenCalledTimes(1);
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const realNow = performance.now.bind(performance);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
    resources.push(() => clock.mockRestore());
    const write = fixture.store.recordValidation.bind(fixture.store);
    const record = vi.spyOn(fixture.store, 'recordValidation').mockImplementation((...args) => {
      const startedAt = realNow();
      Atomics.store(state, 0, 1);
      Atomics.notify(state, 0);
      if (Atomics.wait(state, 1, 0, 3000) === 'timed-out') throw new Error('writer lock not acquired');
      clock.mockImplementation(() => realNow() - startedAt);
      return write(...args);
    });
    const result = await validateLearningCandidate(fixture.input, fixture.deps, { timeoutMs: 100 });
    expect(record).toHaveBeenCalledTimes(1);
    expect(performance.now()).toBeGreaterThanOrEqual(250);
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
