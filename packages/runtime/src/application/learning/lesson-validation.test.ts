import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, promises as fs, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunEventData, RunEventDraft } from '@afk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { CandidateStore } from './candidate-store.js';
import { candidateProposalSchema } from './contracts.js';
import * as evidenceModule from './evidence.js';
import { canonicalLearningJson } from './requests.js';
import { verifyLessonQaEvidence, type LessonQaConfiguration, type LessonQaDependencies } from './lesson-validation.js';

const scope = 'github:acme/api';
const workItemId = `${scope}#7`;
const cleanups: Array<() => void> = [];
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(options: { git?: boolean; kind?: 'lesson' | 'fact'; hypothesis?: boolean; partial?: boolean; declared?: boolean;
  sourceIdentity?: { runId?: string; workItemId?: string } } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lesson-qa-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let revision = 'a'.repeat(40);
  if (options.git) {
    execFileSync('git', ['init', '-q', root]);
    execFileSync('git', ['-C', root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
      '-c', `core.hooksPath=${join(root, 'no-hooks')}`, 'commit', '--allow-empty', '-qm', 'QA target']);
    revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  const events = new JsonlEventStore({ root: join(root, 'audit') });
  const drafts = (runId: string, data: RunEventData[], actor: 'system' | 'cli' | 'agent' = 'system'): RunEventDraft[] => data.map((entry, index) => ({
    id: `${runId}-${index}-${entry.kind}`, schemaVersion: 1, type: entry.kind, occurredAt: '2026-11-11T00:00:00.000Z',
    context: { traceId: runId, runId, workItemId, profileId: 'fixture', attempt: 1, actor: { kind: actor, id: 'runtime' } },
    correlationId: runId, data: entry,
  }));
  const originalRunId = options.sourceIdentity?.runId ?? 'original-failure';
  await events.append(drafts(originalRunId, [{ kind: 'qa.failed', reason: 'race condition' }]).map(draft => ({ ...draft,
    context: { ...draft.context, workItemId: options.sourceIdentity?.workItemId ?? workItemId } })));
  const sourcePath = events.pathFor(originalRunId);
  if (options.partial) await fs.appendFile(sourcePath, '{');
  if (options.declared) writeFileSync(sourcePath, `${JSON.stringify({ role: 'user', content: 'qa.failed: race condition' })}\n`);
  const pack = await evidenceModule.buildEvidencePack({ sources: [{ id: 'source', kind: options.declared ? 'session' : 'audit',
    path: sourcePath, allowedRoot: events.root, runId: originalRunId }] });
  const proposal = candidateProposalSchema.parse({ kind: options.kind ?? 'lesson', title: 'retry race', statement: 'Serialize competing retries',
    evidenceIds: [pack.entries[0].ref.id], applicability: { project: scope, versions: [], environments: [], preconditions: [], exclusions: [], invalidationConditions: [] },
    payload: options.kind === 'fact' ? { subject: 'retry', rule: 'serialize', classification: 'fact' }
      : { trigger: 'duplicate retry', rootCause: 'check then write race', rootCauseStatus: options.hypothesis ? 'hypothesis' : 'confirmed',
        attempts: ['unbounded retry failed'], fix: 'Hold the vault lock around read and write', prevention: ['Run a two-writer retry test'] } });
  const store = new CandidateStore({ file: join(root, 'candidates.sqlite') });
  cleanups.push(() => store.close());
  const source = store.submitRequest({ request: { version: 1, scope, sourceId: 'original-failure', sourceRunId: 'original-failure', workItemId,
    evidenceDigest: pack.digest, analyzerVersion: 'fixture', reason: 'repaired' }, evidence: pack.entries.map(entry => entry.ref) }, pack);
  const receipt = store.completeRequest(source.key, { version: 1, candidates: [proposal], warnings: [] });
  const candidate = store.getCandidate(receipt.candidateIds[0])!;
  const target = { target: { project: scope, revision, dirty: false } };
  const cycle: RunEventData[] = [{ kind: 'qa.started' }, { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(target) },
    { kind: 'commit.recorded', phase: 'qa', commitSha: revision, branch: 'qa' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }];
  const qa: LessonQaConfiguration = { scope, workItemId, runId: 'independent-qa', targetRevision: revision, root: events.root, auditDigest: '' };
  const reset = async (data = cycle, change?: (draft: RunEventDraft) => RunEventDraft) => {
    await fs.rm(events.pathFor(qa.runId), { force: true });
    const batch = drafts(qa.runId, data).map(draft => change ? change(draft) : draft);
    await events.append(batch);
    if (batch[0].context.runId !== qa.runId) await fs.rename(events.pathFor(batch[0].context.runId), events.pathFor(qa.runId));
    qa.auditDigest = digest(readFileSync(events.pathFor(qa.runId)));
  };
  await reset();
  const input = { candidateId: candidate.id, expectedVersion: candidate.version };
  const dependencies: LessonQaDependencies = { store, qa };
  return { root, store, source, pack, candidate, qa, target, cycle, events, input, dependencies, reset, drafts };
}

describe('lesson independent QA prerequisite with real hash-chained audit', () => {
  it.each([
    { workItemId: 'github:foreign/repository#72' },
    { workItemId: `${scope}#8` },
    { runId: 'foreign-original' },
    { runId: 'independent-qa' },
  ])('rejects actual observed source identity %j despite matching request labels', async sourceIdentity => {
    const current = await fixture({ sourceIdentity });
    expect(current.pack.completeness).toBe('complete');
    expect(current.pack.entries[0].ref.authority).toBe('observed');
    const before = current.store.getCandidate(current.candidate.id);
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked',
      code: sourceIdentity.runId === 'independent-qa' ? 'qa_not_independent' : 'scope_mismatch' });
    expect(current.store.getCandidate(current.candidate.id)).toEqual(before);
    expect(current.store.getValidation(current.candidate.id)).toBeUndefined();
  });

  it('rejects a late same-revision commit followed by a duplicate successful completion', async () => {
    const current = await fixture();
    await current.reset([...current.cycle, current.cycle[2], current.cycle[4]]);
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'qa_unverified' });
  });

  it('accepts a complete new QA cycle after the previous cycle completed', async () => {
    const current = await fixture();
    await current.reset([...current.cycle, ...current.cycle]);
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('verified');
  });

  it('uses sequence ordering while permitting occurredAt clock drift', async () => {
    const current = await fixture();
    await current.reset(current.cycle, draft => draft.data.kind === 'qa.passed'
      ? { ...draft, occurredAt: '2026-11-10T00:00:00.000Z' } : draft);
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('verified');
  });

  it('binds an unvalidated lesson to the configured actual Git revision without writing candidate state', async () => {
    const current = await fixture({ git: true });
    const before = current.store.getCandidate(current.candidate.id);
    const result = await verifyLessonQaEvidence(current.input, current.dependencies);
    expect(result).toMatchObject({ status: 'verified', binding: { candidateId: current.candidate.id, candidateVersion: 1,
      candidateDigest: current.candidate.digest, evidenceDigest: current.pack.digest, scope, workItemId,
      qaRunId: current.qa.runId, targetRevision: current.qa.targetRevision, auditDigest: current.qa.auditDigest, auditSequence: 5 } });
    if (result.status !== 'verified') throw new Error('Expected verified binding');
    const qaPack = await evidenceModule.buildEvidencePack({ sources: [{ id: 'lesson-qa', kind: 'audit', runId: current.qa.runId,
      path: current.events.pathFor(current.qa.runId), allowedRoot: current.qa.root }] });
    expect(result.evidence).toEqual(qaPack.entries.map(entry => entry.ref));
    expect(current.store.getCandidate(current.candidate.id)).toEqual(before);
    expect(current.store.listPublications()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(current.root);
    expect(JSON.stringify(result)).not.toContain('check then write race');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(16 * 1024);
  });

  it('accepts the real runtime ordering where the QA commit is recorded after qa.passed', async () => {
    const current = await fixture();
    await current.reset([current.cycle[0], current.cycle[1], current.cycle[3], current.cycle[2], current.cycle[4]]);
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('verified');
  });

  it('reuses the existing published merge-gate completion route', async () => {
    const current = await fixture();
    await current.reset([...current.cycle.slice(0, -1), { kind: 'change.published', changeId: '7', url: 'https://example.test/7' },
      { kind: 'human_gate.opened', gateId: 'merge:7', reason: 'awaiting review' }]);
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('verified');
  });

  it('blocks without caller-owned QA configuration instead of trusting passed input', async () => {
    const current = await fixture();
    expect(await verifyLessonQaEvidence(current.input, { store: current.store })).toEqual({ status: 'blocked', code: 'qa_unconfigured' });
    expect(await verifyLessonQaEvidence({ ...current.input, passed: true }, current.dependencies)).toEqual({ status: 'blocked', code: 'invalid_input' });
  });

  it.each([{ candidateId: 'not-a-digest', expectedVersion: 1 }, { candidateId: 'a'.repeat(64), expectedVersion: 0 }])('blocks malformed input %j', async input => {
    const current = await fixture();
    expect(await verifyLessonQaEvidence(input, current.dependencies)).toEqual({ status: 'blocked', code: 'invalid_input' });
  });

  it('rejects a noncanonical trusted scope or work item and an absent candidate', async () => {
    const current = await fixture();
    for (const qa of [{ ...current.qa, scope: 'github:acme/api ' }, { ...current.qa, workItemId: 'github:foreign/api#7' },
      { ...current.qa, auditDigest: '' }, { ...current.qa, root: 'relative/audit' }]) {
      expect(await verifyLessonQaEvidence(current.input, { ...current.dependencies, qa })).toEqual({ status: 'blocked', code: 'invalid_input' });
    }
    expect(await verifyLessonQaEvidence({ ...current.input, candidateId: 'f'.repeat(64) }, current.dependencies))
      .toEqual({ status: 'blocked', code: 'candidate_unavailable' });
  });

  it('does not treat unrelated CLI decisions or transcript claims as QA authority', async () => {
    const current = await fixture();
    await current.reset([{ kind: 'decision.made', command: 'ordinary.command', accepted: true },
      { kind: 'agent.session_recorded', sessionId: 'I passed QA' }, ...current.cycle], draft => draft.data.kind === 'decision.made'
        && draft.data.command === 'ordinary.command' ? { ...draft, context: { ...draft.context, actor: { kind: 'cli', id: 'operator' } } } : draft);
    const result = await verifyLessonQaEvidence(current.input, current.dependencies);
    expect(result.status).toBe('verified');
    if (result.status === 'verified') expect(result.evidence).toHaveLength(5);
  });

  it.each([{ kind: 'fact' as const }, { hypothesis: true }, { partial: true }, { declared: true }])('rejects unsupported or insufficient candidate evidence %j', async options => {
    const current = await fixture(options);
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'insufficient_evidence' });
  });

  it.each(['fix', 'prevention', 'rootCause'] as const)('rejects missing concrete %s even if a caller forges a fresh digest', async field => {
    const current = await fixture();
    const proposal = structuredClone(current.candidate.proposal);
    if (proposal.kind !== 'lesson') throw new Error('Expected lesson');
    Object.assign(proposal.payload, { [field]: field === 'prevention' ? [] : '   ' });
    vi.spyOn(current.store, 'getCandidate').mockReturnValue({ ...current.candidate, proposal, digest: digest(canonicalLearningJson(proposal)) });
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'insufficient_evidence' });
  });

  it('rejects stale or source-invalidated candidates without changing their ledger state', async () => {
    const current = await fixture();
    expect(await verifyLessonQaEvidence({ ...current.input, expectedVersion: 2 }, current.dependencies)).toEqual({ status: 'blocked', code: 'stale_candidate' });
    const source = current.store.getRequest(current.source.key)!;
    vi.spyOn(current.store, 'getRequest').mockReturnValue({ ...source, blockedReason: 'source_invalidated' });
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'source_unavailable' });
  });

  it.each(['scope', 'workItemId', 'runId'] as const)('rejects foreign event %s even with a valid chain', async field => {
    const current = await fixture();
    await current.reset(current.cycle, draft => ({ ...draft, context: { ...draft.context,
      ...(field === 'scope' ? { workItemId: 'github:foreign/api#7' } : field === 'workItemId' ? { workItemId: `${scope}#8` } : { runId: 'foreign-qa' }) } }));
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });

  it.each(['agent', 'cli'] as const)('rejects %s claims of authoritative QA', async actor => {
    const current = await fixture();
    await current.reset(current.cycle, draft => ({ ...draft, context: { ...draft.context, actor: { kind: actor, id: 'asserted' } } }));
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });

  it.each(['qa.started', 'qa.passed', 'commit.recorded', 'decision.made', 'run.finished'])('rejects one untrusted authority event %s', async kind => {
    const current = await fixture();
    await current.reset(current.cycle, draft => draft.data.kind === kind ? { ...draft, context: { ...draft.context, actor: { kind: 'agent', id: 'forged' } } } : draft);
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });

  it.each(['qa.started', 'qa.passed', 'commit.recorded', 'decision.made', 'run.finished'])('rejects a partial cycle missing %s', async kind => {
    const current = await fixture();
    await current.reset(current.cycle.filter(entry => entry.kind !== kind));
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });

  it.each([{ kind: 'qa.failed' }, { kind: 'run.finished', outcome: 'failed' }, { kind: 'qa.started' },
    { kind: 'commit.recorded', phase: 'qa', commitSha: 'b'.repeat(40), branch: 'late' },
    { kind: 'decision.made', command: 'experience.qa-target', accepted: false }] satisfies RunEventData[])('rejects late invalidation %j', async event => {
    const current = await fixture();
    await current.reset([...current.cycle, event]);
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });

  it('refuses a same-revision commit or target appended after completion', async () => {
    const current = await fixture();
    for (const event of [current.cycle[1], current.cycle[2]]) {
      await current.reset([...current.cycle, event]);
      expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
    }
  });

  it.each(['dirty', 'revision', 'project', 'missing'])('rejects a mismatched or missing QA target %s', async mode => {
    const current = await fixture();
    const target = mode === 'missing' ? {} : { target: { ...current.target.target,
      ...(mode === 'dirty' ? { dirty: true } : mode === 'revision' ? { revision: 'b'.repeat(40) } : { project: 'github:foreign/api' }) } };
    await current.reset(current.cycle.map(event => event.kind === 'decision.made' ? { ...event, reason: JSON.stringify(target) } : event));
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'target_mismatch' });
  });

  it('rejects a different configured revision and reused source or analysis run identity', async () => {
    const current = await fixture();
    expect(await verifyLessonQaEvidence(current.input, { ...current.dependencies, qa: { ...current.qa, targetRevision: 'c'.repeat(40) } }))
      .toEqual({ status: 'blocked', code: 'target_mismatch' });
    expect(await verifyLessonQaEvidence(current.input, { ...current.dependencies, qa: { ...current.qa, runId: 'original-failure' } }))
      .toEqual({ status: 'blocked', code: 'qa_not_independent' });
    vi.spyOn(current.store, 'listAnalysisAttempts').mockReturnValue([{ requestKey: current.source.key, callId: 'analysis', day: '2026-11-11',
      startedAt: '2026-11-11T00:00:00Z', status: 'started', analysisRunId: current.qa.runId, ownerPid: process.pid, host: 'fixture-host' }]);
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'qa_not_independent' });
  });

  it('refuses transcript-only passed declarations', async () => {
    const current = await fixture();
    await current.reset([{ kind: 'agent.session_recorded', sessionId: 'qa.started qa.passed succeeded', transcriptPath: '/not/read' }]);
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });

  it.each(['type', 'outcome', 'purpose', 'target-json'])('rejects structurally valid chains with malformed or learning-purpose events %s', async mode => {
    const current = await fixture();
    await current.reset(current.cycle, draft => mode === 'type' ? { ...draft, type: 'qa.failed' }
      : mode === 'purpose' ? { ...draft, context: { ...draft.context, purpose: 'learning' } }
      : mode === 'outcome' && draft.data.kind === 'run.finished' ? { ...draft, data: { kind: 'run.finished', outcome: 'passed' } as never }
      : mode === 'target-json' && draft.data.kind === 'decision.made' ? { ...draft, data: { ...draft.data, reason: '{' } } : draft);
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });

  it.each(['tamper', 'truncate', 'append', 'rewrite-valid'])('refuses changed audit snapshots %s', async mode => {
    const current = await fixture();
    const path = current.events.pathFor(current.qa.runId);
    if (mode === 'append') await current.events.append(current.drafts(current.qa.runId, [{ kind: 'qa.failed' }]));
    else if (mode === 'rewrite-valid') {
      await fs.rm(path);
      await current.events.append(current.drafts(current.qa.runId, current.cycle).map(draft => ({ ...draft, id: `rewritten-${draft.id}` })));
    } else writeFileSync(path, mode === 'tamper' ? readFileSync(path, 'utf8').replace('qa.passed', 'qa.failed') : '{');
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'audit_changed' });
  });

  it('rejects hash tampering even if a caller refreshes the expected file digest', async () => {
    const current = await fixture();
    const path = current.events.pathFor(current.qa.runId);
    writeFileSync(path, readFileSync(path, 'utf8').replace('qa.passed', 'qa.failed'));
    current.qa.auditDigest = digest(readFileSync(path));
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });

  it('rejects audit changes between evidence construction and return', async () => {
    const current = await fixture();
    const build = evidenceModule.buildEvidencePack;
    vi.spyOn(evidenceModule, 'buildEvidencePack').mockImplementationOnce(async options => {
      const result = await build(options);
      await current.events.append(current.drafts(current.qa.runId, [{ kind: 'qa.failed' }]));
      return result;
    });
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'audit_changed' });
  });

  it('rejects candidate or QA configuration changes before returning the binding', async () => {
    const current = await fixture();
    const build = evidenceModule.buildEvidencePack;
    vi.spyOn(evidenceModule, 'buildEvidencePack').mockImplementationOnce(async options => {
      const result = await build(options);
      vi.spyOn(current.store, 'getCandidate').mockReturnValue({ ...current.candidate, version: 2 });
      return result;
    });
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'stale_candidate' });
    vi.restoreAllMocks();
    vi.spyOn(evidenceModule, 'buildEvidencePack').mockImplementationOnce(async options => {
      const result = await build(options);
      current.qa.targetRevision = 'b'.repeat(40);
      return result;
    });
    expect(await verifyLessonQaEvidence(current.input, current.dependencies)).toEqual({ status: 'blocked', code: 'audit_changed' });
  });

  it('honors pre-cancellation and cancellation during a real audit read without leaking reason', async () => {
    const current = await fixture();
    const controller = new AbortController();
    controller.abort(null);
    expect(await verifyLessonQaEvidence(current.input, current.dependencies, { signal: controller.signal })).toEqual({ status: 'blocked', code: 'cancelled' });
    const active = new AbortController();
    const realpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementationOnce(async path => { active.abort(new Error('private reason')); return realpath(path); });
    expect(await verifyLessonQaEvidence(current.input, current.dependencies, { signal: active.signal })).toEqual({ status: 'blocked', code: 'cancelled' });
  });

  it('bounds actual audit input before building output references', async () => {
    const current = await fixture();
    writeFileSync(current.events.pathFor(current.qa.runId), 'x'.repeat(1024 * 1024 + 1));
    current.qa.auditDigest = digest(readFileSync(current.events.pathFor(current.qa.runId)));
    expect((await verifyLessonQaEvidence(current.input, current.dependencies)).status).toBe('blocked');
  });
});
