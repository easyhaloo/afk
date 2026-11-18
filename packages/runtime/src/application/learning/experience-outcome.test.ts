import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openSqlite, type SqliteDatabase } from '../../infrastructure/storage/sqlite.js';
import { ExperienceStore, type ExperienceOutcomeEvent, type RecordFailureInput } from './experience-store.js';
import { createLessonPublicationFixture } from './lesson-publication.fixture.spec.js';
import { knowledgeDigest, knowledgeTargetDigest, type KnowledgePlan } from './knowledge.js';
import { wikiScript } from './knowledge.fixture.spec.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { createPluginRunObserver } from '../plugins/observability.js';
import { createLearningPlugin } from '../plugins/learning.js';
import { ExperienceContextProvider, recordExperienceOutcomes } from './runtime.js';
import { validateConfiguredLearningCandidate } from './validation-runtime.js';
import type { RunEventData } from '@afk/core';
import { buildEvidencePack } from './evidence.js';

const roots: string[] = [];
const stores: ExperienceStore[] = [];
const databases: SqliteDatabase[] = [];
const publicationCleanups: Array<() => void> = [];
const plugins: PluginRuntime[] = [];
const scope = 'github:acme/wiki';
const source = { runId: 'consumer', workItemId: `${scope}#2` };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const selectedAt = '2026-11-16T00:00:00.000Z';
const later = '2026-11-16T00:00:01.000Z';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'experience-outcome-'));
  roots.push(root);
  const file = join(root, 'experience.sqlite');
  let time = selectedAt;
  const store = new ExperienceStore({ file, now: () => new Date(time) });
  stores.push(store);
  const failure: RecordFailureInput = { scope, trigger: 'database locked', rootCause: 'parallel writes', action: 'use transactions',
    source: { runId: 'original-failure', workItemId: `${scope}#1` }, evidence: ['evidence://original'] };
  const record = store.recordFailure(failure);
  store.verify(record.id, { runId: 'independent-qa', evidence: ['evidence://regression'] });
  const select = (id = record.id, selectedSource = source, selected = true) => {
    const retrieved = store.recordContextRetrieval({ id, scope, source: selectedSource, selectionId: randomUUID(),
      fragmentDigest: digest('retrieved') });
    return selected ? store.recordContextSelection({ retrieved, fragmentDigest: digest('final') }) : retrieved;
  };
  const event = (overrides: Partial<ExperienceOutcomeEvent> = {}): ExperienceOutcomeEvent => ({ runId: source.runId,
    sequence: 1, hash: digest('event-1'), type: 'qa.failed', outcome: 'failed', occurredAt: later, observedAt: later, ...overrides });
  const recurrence = { ...failure, source, evidence: ['evidence://independent-recurrence'] };
  const database = openSqlite({ file, schema: '', version: 3 });
  databases.push(database);
  return { store, file, database, record, failure, recurrence, select, event, setTime: (value: string) => { time = value; } };
}

afterEach(async () => {
  for (const runtime of plugins.splice(0)) await runtime.dispose();
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const cleanup of publicationCleanups.splice(0).reverse()) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function publishedFixture(options: { localFailure?: boolean; file?: string; production?: boolean;
  sourceEvents?: RunEventData[]; evidenceIndices?: number[]; observedSource?: boolean } = {}) {
  let current = await createLessonPublicationFixture({ versions: ['fixture-v1'], homeStorage: options.production,
    registerCleanup: cleanup => publicationCleanups.push(cleanup) });
  if (options.production) {
    if (current.candidate.proposal.kind !== 'lesson') throw new Error('Expected lesson fixture');
    if (options.sourceEvents) {
      if (options.observedSource) {
        const runtime = new PluginRuntime();
        plugins.push(runtime);
        await runtime.load(createLearningPlugin({ homeDir: current.root, config: { enabled: true, dailyCalls: 0 } }));
        const configured = createPluginRunObserver(runtime, current.events.root);
        for (const data of [...options.sourceEvents, { kind: 'qa.started' } as const, { kind: 'qa.passed' } as const,
          { kind: 'run.finished', outcome: 'succeeded' } as const]) {
          await configured.record({ runId: 'original-failure', workItemId: current.workItemId, traceId: 'original-failure',
            profileId: 'fixture', attempt: 1, actor: { kind: 'system', id: 'runtime' } }, data);
        }
      } else await current.append('original-failure', options.sourceEvents);
      const pack = await buildEvidencePack({ sources: [current.sourceInput] });
      current.configuration.checkers[0].evidence = [{ digest: pack.digest, sources: [current.sourceInput] }];
      current.persistConfiguration();
      current = { ...current, pack };
    }
    const proposal = { ...current.candidate.proposal, payload: { ...current.candidate.proposal.payload,
      trigger: 'qa_execution_failed', rootCause: 'Independent QA Duplicate retry race' },
    evidenceIds: (options.evidenceIndices ?? [0]).map(index => current.pack.entries[index].ref.id) };
    const captured = options.observedSource ? current.store.listRequests().find(entry => entry.request.sourceRunId === 'original-failure'
      && entry.request.analyzerVersion === '1' && entry.request.evidenceDigest === current.pack.digest) : undefined;
    if (options.observedSource) expect(captured, 'observer learning.capture must persist the real source request').toBeDefined();
    const source = captured ?? current.store.submitRequest({ request: { ...current.source.request, evidenceDigest: current.pack.digest,
      analyzerVersion: 'production-feedback' }, evidence: current.pack.entries.map(entry => entry.ref) }, current.pack);
    const completed = current.store.completeRequest(source.key, { version: 1, warnings: [], candidates: [proposal] });
    const candidateId = completed.candidateIds[0];
    const oracle = JSON.parse(readFileSync(current.oracle, 'utf8'));
    oracle['lesson.trigger'] = proposal.payload.trigger;
    oracle['lesson.rootCause'] = proposal.payload.rootCause;
    writeFileSync(current.oracle, JSON.stringify(oracle));
    expect(await validateConfiguredLearningCandidate({ scope: current.scope, candidateId, expectedVersion: 1, checkerId: 'lesson-checker' },
      { file: current.file, configurationFile: current.configurationFile, resolveProvider: async () => current.provider }))
      .toMatchObject({ status: 'validated' });
    current = { ...current, candidate: current.store.getCandidate(candidateId)!, receipt: current.store.getValidation(candidateId)! };
  }
  const candidate = current.candidate;
  const content = '# Retry race\nSerialize retry read and write\n';
  const plan: KnowledgePlan = { candidateId: candidate.id, candidateVersion: candidate.version, candidateDigest: candidate.digest,
    evidenceDigest: candidate.evidenceDigest, validatorVersion: current.receipt.validatorVersion, targetRef: 'wiki:retry',
    policyDigest: knowledgeDigest(current.grant.policy), authorizationFile: current.authorizationFile,
    authorizationDigest: knowledgeDigest(current.grant), reused: false, classification: 'lesson',
    applicability: candidate.proposal.applicability, proposal: candidate.proposal,
    plan: { version: 1, summary: 'Publish validated lesson', evidence: candidate.proposal.evidenceIds,
      changes: [{ path: 'Retry.md', expected_sha256: null, content }] }, withdrawalContent: '', readSet: {}, searches: [] };
  const key = knowledgeDigest(plan);
  const recoveryDirectory = options.production ? join(current.root, '.afk', 'learning', 'publications') : join(current.root, 'publication-snapshots');
  const snapshotDirectory = join(recoveryDirectory, key);
  mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(snapshotDirectory, 'plan.json'), JSON.stringify(plan), { mode: 0o600 });
  const publication = current.store.preparePublication(candidate.id, candidate.version, { key, validatorVersion: plan.validatorVersion,
    targetRef: plan.targetRef, originalDigest: knowledgeDigest([{ path: 'Retry.md', sha256: null }]),
    targetDigest: knowledgeTargetDigest(plan.plan), recoveryRef: `wiki:${key}` });
  writeFileSync(join(current.vault, 'Retry.md'), content);
  current.store.advancePublication(key, 'applied', publication.targetDigest);
  expect(current.store.advancePublication(key, 'committed', publication.targetDigest).phase).toBe('committed');
  const file = options.file ?? join(dirname(current.file), 'experience.sqlite');
  const knowledge = { file: current.file, recoveryDirectory, validationConfigurationFile: current.configurationFile,
    config: { wikiScript, grants: [current.authorizationFile] } };
  if (options.production) writeFileSync(join(current.root, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [
    { id: 'learning.distiller', builtin: true, config: { knowledge: knowledge.config,
      validation: { configurationFile: current.configurationFile } } },
  ] }));
  const store = new ExperienceStore({ file, knowledge, now: () => new Date(selectedAt) });
  stores.push(store);
  if (candidate.proposal.kind !== 'lesson') throw new Error('Expected lesson fixture');
  const sourceOutcomes = vi.spyOn(ExperienceStore.prototype, 'recordRunOutcome');
  await recordExperienceOutcomes({ runId: 'original-failure', workItemId: current.workItemId, root: current.events.root, file });
  const sourceSequence = JSON.parse(current.pack.entries[options.evidenceIndices?.[0] ?? 0].content).sequence;
  const sourceFailure = (sourceOutcomes.mock.calls.find(([input]) => input.failure && input.event.sequence === sourceSequence)
    ?? sourceOutcomes.mock.calls.find(([input]) => input.failure))?.[0].failure!;
  sourceOutcomes.mockRestore();
  const local = options.localFailure ? store.recordFailure({ ...sourceFailure,
    source: { runId: 'local-original-failure', workItemId: `${current.scope}#18` }, evidence: ['run:local-original-failure#qa.failed'] }) : undefined;
  const record = store.projectPublishedLesson({ scope: current.scope, key });
  const query = { scope: current.scope, prompt: record.trigger, applicability: { version: 'fixture-v1' } };
  expect(store.recall(query).map(entry => entry.id)).toEqual([record.id]);
  const consumer = { runId: 'published-consumer', workItemId: `${current.scope}#20` };
  const retrieved = store.recordContextRetrieval({ id: record.id, scope: current.scope, source: consumer,
    selectionId: randomUUID(), fragmentDigest: digest('published-fragment') }, { applicability: query.applicability });
  const selected = store.recordContextSelection({ retrieved, fragmentDigest: digest('selected-published-fragment') });
  const failure: RecordFailureInput = { ...sourceFailure,
    evidence: ['run:published-consumer#failure.classified'], source: consumer };
  const event: ExperienceOutcomeEvent = { runId: consumer.runId, sequence: 1, hash: digest('published-failure-event'),
    type: 'failure.classified', outcome: 'failed', occurredAt: later, observedAt: later };
  return { ...current, store, file, knowledge, record, query, consumer, selected, failure, event, local,
    input: { scope: record.scope, source: consumer, failure, event } };
}

function removePublishedFailureIdentity(test: Awaited<ReturnType<typeof publishedFixture>>) {
  const database = openSqlite({ file: test.file, schema: '', version: 3 });
  databases.push(database);
  const payload = { ...test.record };
  delete payload.failureFingerprint;
  delete payload.failureIdentity;
  delete payload.failureIdentityEvidence;
  const serialized = JSON.stringify(payload);
  database.prepare('UPDATE experiences SET payload = ?, bytes = ? WHERE id = ?').run(serialized, Buffer.byteLength(serialized), payload.id);
  return database;
}

function installRedactedPublishedAlias(test: Awaited<ReturnType<typeof publishedFixture>>) {
  const database = openSqlite({ file: test.file, schema: '', version: 3 });
  databases.push(database);
  const failureIdentity = { ...test.record.failureIdentity!, rootCause: JSON.parse(test.pack.entries[1].content).data.summary.slice(0, 480) };
  const old = { ...test.record, failureIdentity, failureIdentityEvidence: { ...test.record.failureIdentityEvidence!, version: undefined },
    failureFingerprint: digest(JSON.stringify([test.record.scope, failureIdentity.trigger, failureIdentity.rootCause, failureIdentity.action])) };
  const payload = JSON.stringify(old);
  database.prepare('UPDATE experiences SET payload = ?, bytes = ? WHERE id = ?').run(payload, Buffer.byteLength(payload), old.id);
  return database;
}

describe('production published failure feedback', () => {
  async function observer(test: Awaited<ReturnType<typeof publishedFixture>>) {
    const runtime = new PluginRuntime();
    plugins.push(runtime);
    await runtime.load({ manifest: { id: 'context.published-experience', version: '1.0.0', apiVersion: 1,
      trusted: true, provides: ['context.provider'] }, activate(setup) {
      setup.registerContextProvider('context.experience', new ExperienceContextProvider(test.file, { homeDir: test.root }));
    } });
    const configured = createPluginRunObserver(runtime, test.events.root);
    return { record: (data: RunEventData) => configured.record({ ...test.consumer, traceId: test.consumer.runId,
      profileId: 'fixture', attempt: 1, actor: { kind: 'system' as const, id: 'runtime' } }, data) };
  }

  const privateFailures = [
    ['path', 'Cannot open /srv/fixture/private/cache.sqlite during retry'],
    ['ip', 'Cannot reach 192.0.2.41 during retry'],
    ['url', 'Cannot reach https://fixture.invalid/private/retry during retry'],
    ['truncated-url', `${'retry '.repeat(76)}https://fixture.invalid/private/retry after a long diagnostic`],
  ] as const;

  it.each(privateFailures)('preserves the raw %s identity through observer capture, publication and outcomes', async (_kind, summary) => {
    const data: RunEventData = { kind: 'qa.failed', reasonCode: 'qa_execution_failed', summary };
    const test = await publishedFixture({ production: true, observedSource: true, sourceEvents: [data], evidenceIndices: [1] });
    expect(JSON.parse(test.pack.entries[1].content).data.summary).not.toBe(summary);
    const audit = await (await observer(test)).record(data);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toMatchObject([
      { selected: test.selected, event: { sequence: audit.lastSequence, hash: audit.lastHash }, recurrence: true, benefit: 'unknown' },
    ]);
    const updated = test.store.get(test.record.id, test.record.scope)!;
    expect(updated).toMatchObject({ status: 'candidate', fingerprint: test.record.fingerprint, action: test.record.action,
      publication: test.record.publication, failureIdentity: { rootCause: summary.slice(0, 480) } });
    expect(test.store.recall(test.query)).toEqual([]);
    const metrics = test.store.metrics({ scope: test.record.scope });
    expect(metrics).toMatchObject({ recurrences: 1, adoptions: 0 });
    const receipts = test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer });
    expect(await recordExperienceOutcomes({ ...test.consumer, file: test.file, root: test.events.root, homeDir: test.root })).toEqual(receipts);
    expect(test.store.metrics({ scope: test.record.scope })).toEqual(metrics);
  });

  it('repairs an existing redacted alias with evidence inside the observer outcome transaction', async () => {
    const data: RunEventData = { kind: 'qa.failed', reasonCode: 'qa_execution_failed', summary: 'Cannot open /srv/fixture/old/cache.sqlite' };
    const test = await publishedFixture({ production: true, observedSource: true, sourceEvents: [data], evidenceIndices: [1] });
    installRedactedPublishedAlias(test);
    expect(test.store.get(test.record.id, test.record.scope)?.failureIdentityEvidence).toBeDefined();
    await (await observer(test)).record(data);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toMatchObject([{ recurrence: true }]);
    expect(test.store.get(test.record.id, test.record.scope)).toMatchObject({ status: 'candidate',
      failureIdentity: { rootCause: data.summary }, failureIdentityEvidence: { version: 2 },
      fingerprint: test.record.fingerprint, publication: test.record.publication, action: test.record.action });
  });

  it('keeps distinct raw failures independent when their evidence summaries redact identically', async () => {
    const first: RunEventData = { kind: 'qa.failed', reasonCode: 'qa_execution_failed', summary: 'Cannot open /srv/fixture/first/cache.sqlite' };
    const second: RunEventData = { ...first, summary: 'Cannot open /srv/fixture/second/cache.sqlite' };
    const test = await publishedFixture({ production: true, observedSource: true, sourceEvents: [first, second], evidenceIndices: [1, 2] });
    expect(JSON.parse(test.pack.entries[1].content).data.summary).toBe(JSON.parse(test.pack.entries[2].content).data.summary);
    expect(test.record.failureIdentityEvidence).toBeUndefined();
    await (await observer(test)).record(first);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toMatchObject([{ recurrence: false }]);
    expect(test.store.get(test.record.id, test.record.scope)).toEqual(test.record);
  });

  it('does not match a new raw path merely because it redacts to the same source summary', async () => {
    const data: RunEventData = { kind: 'qa.failed', reasonCode: 'qa_execution_failed', summary: 'Cannot open /srv/fixture/first/cache.sqlite' };
    const test = await publishedFixture({ production: true, observedSource: true, sourceEvents: [data], evidenceIndices: [1] });
    await (await observer(test)).record({ ...data, summary: 'Cannot open /srv/fixture/second/cache.sqlite' });
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toMatchObject([{ recurrence: false }]);
    expect(test.store.get(test.record.id, test.record.scope)).toEqual(test.record);
    expect(test.store.recall(test.query).map(entry => entry.id)).toEqual([test.record.id]);
  });

  it.each(['experience', 'publication'] as const)('keeps raw identity history after %s withdrawal and replay without restoring recall', async withdrawal => {
    const data: RunEventData = { kind: 'qa.failed', reasonCode: 'qa_execution_failed', summary: 'Cannot reach https://fixture.invalid/withdrawn' };
    const test = await publishedFixture({ production: true, observedSource: true, sourceEvents: [data], evidenceIndices: [1] });
    if (withdrawal === 'experience') {
      installRedactedPublishedAlias(test);
      test.store.revoke(test.record.id);
    } else { test.grant.revoked = true; test.persistGrant(); }
    await (await observer(test)).record(data);
    const receipts = test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer });
    expect(receipts).toMatchObject([{ selected: test.selected, recurrence: true, benefit: 'unknown' }]);
    expect(test.store.get(test.record.id, test.record.scope)).toMatchObject({
      status: withdrawal === 'experience' ? 'revoked' : 'candidate', failureIdentity: { rootCause: data.summary } });
    const metrics = test.store.metrics({ scope: test.record.scope });
    expect(await recordExperienceOutcomes({ ...test.consumer, file: test.file, root: test.events.root, homeDir: test.root })).toEqual(receipts);
    expect(test.store.metrics({ scope: test.record.scope })).toEqual(metrics);
    expect(test.store.contextReceipts({ scope: test.record.scope, source: test.consumer })).toContainEqual(test.selected);
    expect(test.store.recall(test.query)).toEqual([]);
  });

  it('rolls back repair of an existing redacted alias with local aggregation and observer outcome receipts', async () => {
    const data: RunEventData = { kind: 'qa.failed', reasonCode: 'qa_execution_failed', summary: 'Cannot reach 192.0.2.41 during retry' };
    const test = await publishedFixture({ production: true, observedSource: true, sourceEvents: [data], evidenceIndices: [1], localFailure: true });
    const database = installRedactedPublishedAlias(test);
    database.exec(`CREATE TRIGGER fail_raw_alias_outcome BEFORE INSERT ON experience_receipts
      WHEN NEW.source_hash LIKE 'metric:outcome:%' BEGIN SELECT RAISE(ABORT, 'raw alias outcome failure'); END`);
    const before = test.store.list({ scope: test.record.scope });
    const metrics = test.store.metrics({ scope: test.record.scope });
    const configured = await observer(test);
    const audit = await configured.record(data);
    expect((await test.events.verify(test.consumer.runId)).lastHash).toBe(audit.lastHash);
    expect(test.store.list({ scope: test.record.scope })).toEqual(before);
    expect(test.store.metrics({ scope: test.record.scope })).toEqual(metrics);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toEqual([]);
    expect(test.store.recordUnselectedFailure(test.failure)).toBeUndefined();
    database.exec('DROP TRIGGER fail_raw_alias_outcome');
    expect(await recordExperienceOutcomes({ ...test.consumer, file: test.file, root: test.events.root, homeDir: test.root }))
      .toMatchObject([{ recurrence: true }]);
    expect(test.store.get(test.record.id, test.record.scope)).toMatchObject({ status: 'candidate',
      failureIdentity: { rootCause: data.summary }, failureIdentityEvidence: { version: 2 } });
    expect(test.store.get(test.local!.id, test.record.scope)).toMatchObject({ occurrences: 2 });
  });

  it('associates the observer failure with its published source evidence despite a different corrective fix', async () => {
    const test = await publishedFixture({ production: true });
    const configured = await observer(test);
    const outcomes = vi.spyOn(ExperienceStore.prototype, 'recordRunOutcome');
    const original = JSON.parse(test.pack.entries[0].content);
    const audit = await configured.record(original.data);
    const input = outcomes.mock.calls.at(-1)![0];
    expect(input.failure!.action).not.toBe(test.record.action);
    expect(input.failure!.trigger).toBe(test.record.trigger);
    expect(input.failure!.rootCause).toBe(test.record.rootCause);
    expect(input.failure!.source).toEqual(test.consumer);
    const receipts = test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer });
    expect(receipts, JSON.stringify({ actualInput: input, published: test.store.get(test.record.id, test.record.scope), receipts })).toMatchObject([
      { selected: test.selected, event: { sequence: audit.lastSequence, hash: audit.lastHash }, recurrence: true, benefit: 'unknown' },
    ]);
    expect(test.store.get(test.record.id, test.record.scope)).toMatchObject({ status: 'candidate',
      action: test.record.action, fingerprint: test.record.fingerprint, publication: test.record.publication });
    expect(test.store.recall(test.query)).toEqual([]);
    const metrics = test.store.metrics({ scope: test.record.scope });
    expect(metrics).toMatchObject({ recurrences: 1, adoptions: 0 });
    expect(await recordExperienceOutcomes({ ...test.consumer, file: test.file, root: test.events.root, homeDir: test.root }))
      .toEqual(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer }));
    expect(test.store.metrics({ scope: test.record.scope })).toEqual(metrics);
  });

  it('uses the referenced failure.classified identity and its persisted sequence and hash', async () => {
    const data: RunEventData = { kind: 'failure.classified', code: 'qa_execution_failed', failureClass: 'verification',
      summary: 'Independent QA Duplicate retry race' };
    const test = await publishedFixture({ production: true, sourceEvents: [data], evidenceIndices: [1] });
    const original = JSON.parse(test.pack.entries[1].content);
    expect(test.record.failureIdentityEvidence).toEqual({ version: 2, id: test.pack.entries[1].ref.id,
      sequence: original.sequence, hash: original.integrity.hash });
    await (await observer(test)).record(data);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer }))
      .toMatchObject([{ event: { type: 'failure.classified' }, recurrence: true }]);
    expect(test.store.get(test.record.id, test.record.scope)).toMatchObject({ status: 'candidate', action: test.record.action });
  });

  it.each(['missing', 'lesson-fix'] as const)('repairs %s legacy identity from bound evidence in the observer transaction', async legacy => {
    const test = await publishedFixture({ production: true, localFailure: true });
    const database = removePublishedFailureIdentity(test);
    if (legacy === 'lesson-fix') {
      const old = { ...test.record, failureIdentityEvidence: undefined, failureIdentity: { trigger: test.record.trigger,
        rootCause: test.record.rootCause, action: test.record.action }, failureFingerprint: digest(JSON.stringify([
        test.record.scope, test.record.trigger, test.record.rootCause, test.record.action])) };
      const payload = JSON.stringify(old);
      database.prepare('UPDATE experiences SET payload = ?, bytes = ? WHERE id = ?').run(payload, Buffer.byteLength(payload), old.id);
    }
    await (await observer(test)).record(JSON.parse(test.pack.entries[0].content).data);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toMatchObject([{ recurrence: true }]);
    expect(test.store.get(test.record.id, test.record.scope)).toMatchObject({ status: 'candidate',
      failureIdentity: { trigger: test.failure.trigger, rootCause: test.failure.rootCause, action: test.failure.action },
      failureIdentityEvidence: test.record.failureIdentityEvidence,
      action: test.record.action, publication: test.record.publication, fingerprint: test.record.fingerprint });
    expect(test.store.get(test.local!.id, test.record.scope)).toMatchObject({ occurrences: 2 });
  });

  it.each(['experience', 'publication'] as const)('retains historical binding after %s withdrawal and cold replay', async withdrawal => {
    const test = await publishedFixture({ production: true });
    if (withdrawal === 'experience') test.store.revoke(test.record.id);
    else { test.grant.revoked = true; test.persistGrant(); }
    await (await observer(test)).record(JSON.parse(test.pack.entries[0].content).data);
    const receipts = test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer });
    expect(receipts).toMatchObject([{ selected: test.selected, recurrence: true, benefit: 'unknown' }]);
    expect(test.store.get(test.record.id, test.record.scope)?.status).toBe(withdrawal === 'experience' ? 'revoked' : 'candidate');
    const metrics = test.store.metrics({ scope: test.record.scope });
    expect(await recordExperienceOutcomes({ ...test.consumer, file: test.file, root: test.events.root, homeDir: test.root })).toEqual(receipts);
    expect(test.store.metrics({ scope: test.record.scope })).toEqual(metrics);
    expect(test.store.recall(test.query)).toEqual([]);
  });

  it('does not infer a legacy identity from identical lesson text after source authorization is withdrawn', async () => {
    const test = await publishedFixture({ production: true });
    removePublishedFailureIdentity(test);
    test.grant.revoked = true;
    test.persistGrant();
    await (await observer(test)).record(JSON.parse(test.pack.entries[0].content).data);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toMatchObject([{ recurrence: false }]);
    expect(test.store.get(test.record.id, test.record.scope)?.failureIdentityEvidence).toBeUndefined();
    expect(test.store.recall(test.query)).toEqual([]);
  });

  it.each(['unreferenced', 'ambiguous', 'without-code'] as const)('does not assign recurrence from %s failure evidence', async kind => {
    const extra: RunEventData = kind === 'unreferenced' ? { kind: 'run.finished', outcome: 'succeeded' }
      : { kind: 'failure.classified', summary: 'Independent QA Duplicate retry race', failureClass: 'verification',
        ...(kind === 'ambiguous' ? { code: 'qa_rework' as const } : {}) };
    const test = await publishedFixture({ production: true, sourceEvents: [extra], evidenceIndices: kind === 'ambiguous' ? [0, 1] : [1] });
    expect(test.record.failureFingerprint).toBeUndefined();
    expect(test.record.failureIdentityEvidence).toBeUndefined();
    await (await observer(test)).record(JSON.parse(test.pack.entries[0].content).data);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toMatchObject([{ recurrence: false }]);
    expect(test.store.get(test.record.id, test.record.scope)).toEqual(test.record);
    expect(test.store.metrics({ scope: test.record.scope })).toMatchObject({ recurrences: 0, adoptions: 0 });
  });

  it('keeps an identical summary with a different diagnostic code independent', async () => {
    const test = await publishedFixture({ production: true });
    await (await observer(test)).record({ kind: 'qa.failed', reason: 'Duplicate retry race', reasonCode: 'qa_rework' });
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toMatchObject([{ recurrence: false }]);
    expect(test.store.get(test.record.id, test.record.scope)).toEqual(test.record);
    expect(test.store.recall(test.query).map(entry => entry.id)).toEqual([test.record.id]);
  });

  it('rolls back legacy identity repair and aggregation when the observer outcome cannot commit', async () => {
    const test = await publishedFixture({ production: true, localFailure: true });
    const database = removePublishedFailureIdentity(test);
    database.exec(`CREATE TRIGGER fail_repaired_outcome BEFORE INSERT ON experience_receipts
      WHEN NEW.source_hash LIKE 'metric:outcome:%' BEGIN SELECT RAISE(ABORT, 'repaired outcome failure'); END`);
    const before = test.store.list({ scope: test.record.scope });
    const metrics = test.store.metrics({ scope: test.record.scope });
    const audit = await (await observer(test)).record(JSON.parse(test.pack.entries[0].content).data);
    expect((await test.events.verify(test.consumer.runId)).lastHash).toBe(audit.lastHash);
    expect(test.store.list({ scope: test.record.scope })).toEqual(before);
    expect(test.store.metrics({ scope: test.record.scope })).toEqual(metrics);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toEqual([]);
    expect(test.store.recordUnselectedFailure(test.failure)).toBeUndefined();
    database.exec('DROP TRIGGER fail_repaired_outcome');
    expect(await recordExperienceOutcomes({ ...test.consumer, file: test.file, root: test.events.root, homeDir: test.root }))
      .toMatchObject([{ selected: test.selected, recurrence: true }]);
    expect(test.store.get(test.record.id, test.record.scope)).toMatchObject({ status: 'candidate',
      failureIdentityEvidence: test.record.failureIdentityEvidence });
    expect(test.store.get(test.local!.id, test.record.scope)).toMatchObject({ occurrences: 2 });
  });
});

describe('published lesson outcome recurrence', () => {
  it('links an independent matching failure to the real publication without replacing its identity', async () => {
    const test = await publishedFixture();
    const result = test.store.recordRunOutcome(test.input);
    expect(result.receipts[0].recurrence).toBe(true);
    expect(result.receipts).toMatchObject([{ selected: test.selected, recurrence: true, benefit: 'unknown' }]);
    expect(result.failure?.id).toBe(test.record.id);
    expect(test.store.get(test.record.id, test.record.scope)).toMatchObject({ status: 'candidate',
      fingerprint: test.record.fingerprint, publication: test.record.publication, evidence: test.record.evidence, occurrences: 2 });
    expect(test.store.recall(test.query)).toEqual([]);
    expect(test.store.metrics({ scope: test.record.scope })).toMatchObject({ recurrences: 1, adoptions: 0 });
  });

  it.each([false, true])('associates legacy projections after reopening with existing local failure = %s', async localFailure => {
    const test = await publishedFixture({ localFailure });
    removePublishedFailureIdentity(test);
    test.store.close();
    const reopened = new ExperienceStore({ file: test.file, knowledge: test.knowledge });
    stores.push(reopened);
    const result = reopened.recordRunOutcome(test.input);
    expect(result.receipts).toMatchObject([{ selected: test.selected, recurrence: true }]);
    const updated = reopened.get(test.record.id, test.record.scope)!;
    expect(updated).toMatchObject({ fingerprint: test.record.fingerprint, publication: test.record.publication,
      status: 'candidate', occurrences: 2, failureIdentity: { trigger: test.failure.trigger,
        rootCause: test.failure.rootCause, action: test.failure.action } });
    expect(updated.failureFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(updated.failureFingerprint).not.toBe(updated.fingerprint);
    if (test.local) expect(reopened.get(test.local.id, test.record.scope)).toMatchObject({ occurrences: 2 });
    expect(reopened.list({ scope: test.record.scope })).toHaveLength(localFailure ? 2 : 1);
    const metrics = reopened.metrics({ scope: test.record.scope });
    expect(reopened.recordRunOutcome(test.input).receipts).toEqual(result.receipts);
    expect(reopened.metrics({ scope: test.record.scope })).toEqual(metrics);
    expect(reopened.projectPublishedLesson({ scope: test.record.scope, key: test.record.publication!.key })).toEqual(updated);
  });

  it('backfills legacy identity on projection replay without granting fresh verification', async () => {
    const test = await publishedFixture();
    removePublishedFailureIdentity(test);
    test.store.revoke(test.record.id);
    const updated = test.store.projectPublishedLesson({ scope: test.record.scope, key: test.record.publication!.key });
    expect(updated).toMatchObject({ fingerprint: test.record.fingerprint, publication: test.record.publication,
      status: 'revoked', failureIdentity: { trigger: test.failure.trigger, rootCause: test.failure.rootCause, action: test.failure.action } });
    expect(updated.failureFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(test.store.recall(test.query)).toEqual([]);
  });

  it('allows fresh independent verification of a coexisting local asset without revalidating its publication', async () => {
    const test = await publishedFixture({ localFailure: true });
    test.store.recordRunOutcome(test.input);
    const publication = test.store.get(test.record.id, test.record.scope);
    const local = test.store.verify(test.local!.id, { runId: 'fresh-local-qa', evidence: ['run:fresh-local-qa#passed'] });
    expect(local).toMatchObject({ id: test.local!.id, status: 'verified' });
    expect(test.store.get(test.record.id, test.record.scope)).toEqual(publication);
    expect(publication?.status).toBe('candidate');
  });

  it.each(['experience', 'publication'] as const)('keeps history and replay after %s withdrawal without restoring recall', async withdrawal => {
    const test = await publishedFixture();
    if (withdrawal === 'experience') test.store.revoke(test.record.id);
    else { test.grant.revoked = true; test.persistGrant(); }
    expect(test.store.recall(test.query)).toEqual([]);
    const result = test.store.recordRunOutcome(test.input);
    expect(result.receipts).toMatchObject([{ selected: test.selected, recurrence: true, benefit: 'unknown' }]);
    expect(test.store.get(test.record.id, test.record.scope)?.status).toBe(withdrawal === 'experience' ? 'revoked' : 'candidate');
    const metrics = test.store.metrics({ scope: test.record.scope });
    test.store.close();
    const reopened = new ExperienceStore({ file: test.file, knowledge: test.knowledge });
    stores.push(reopened);
    expect(reopened.recordRunOutcome(test.input).receipts).toEqual(result.receipts);
    expect(reopened.metrics({ scope: test.record.scope })).toEqual(metrics);
    expect(reopened.contextReceipts({ scope: test.record.scope, source: test.consumer })).toContainEqual(test.selected);
    expect(reopened.recall(test.query)).toEqual([]);
    expect(() => reopened.recordContextRetrieval({ id: test.record.id, scope: test.record.scope, source: test.consumer,
      selectionId: randomUUID(), fragmentDigest: digest('new-fragment') }, { applicability: test.query.applicability })).toThrow();
  });

  it.each(['trigger', 'rootCause', 'action'] as const)('does not infer matching root cause when only %s differs', async field => {
    const test = await publishedFixture();
    const result = test.store.recordRunOutcome({ ...test.input, failure: { ...test.failure, [field]: `different ${test.failure[field]}` } });
    expect(result.receipts).toMatchObject([{ recurrence: false, benefit: 'unknown' }]);
    expect(test.store.get(test.record.id, test.record.scope)).toEqual(test.record);
    expect(test.store.recall(test.query).map(entry => entry.id)).toEqual([test.record.id]);
    expect(test.store.metrics({ scope: test.record.scope })).toMatchObject({ recurrences: 0, adoptions: 0 });
  });

  it('does not count another observation of the publication source run as independent recurrence', async () => {
    const test = await publishedFixture();
    removePublishedFailureIdentity(test);
    const result = test.store.recordFailure({ ...test.failure, source: test.record.source, evidence: ['run:original-failure#additional-evidence'] });
    expect(result).toMatchObject({ id: test.record.id, status: 'verified', occurrences: 1, evidence: test.record.evidence });
    expect(test.store.recall(test.query).map(entry => entry.id)).toEqual([test.record.id]);
    expect(test.store.metrics({ scope: test.record.scope }).recurrences).toBe(0);
  });

  it('attributes recurrence independently to every selected publication sharing the full failure identity', async () => {
    const first = await publishedFixture();
    const second = await publishedFixture({ file: first.file });
    expect(first.record.publication!.key).not.toBe(second.record.publication!.key);
    const result = second.store.recordRunOutcome(second.input);
    expect(result.receipts).toHaveLength(2);
    for (const record of [first.record, second.record]) {
      expect(result.receipts.find(receipt => receipt.selected.experienceId === record.id)).toMatchObject({ recurrence: true });
      expect(second.store.get(record.id, record.scope)).toMatchObject({ status: 'candidate', fingerprint: record.fingerprint,
        publication: record.publication, occurrences: 2 });
    }
    const metrics = second.store.metrics({ scope: second.record.scope });
    expect(second.store.recordRunOutcome(second.input).receipts).toEqual(result.receipts);
    expect(second.store.metrics({ scope: second.record.scope })).toEqual(metrics);
  });

  it('rolls back publication demotion and local aggregation when its outcome cannot commit', async () => {
    const test = await publishedFixture({ localFailure: true });
    const database = openSqlite({ file: test.file, schema: '', version: 3 });
    databases.push(database);
    database.exec(`CREATE TRIGGER fail_publication_outcome BEFORE INSERT ON experience_receipts
      WHEN NEW.source_hash LIKE 'metric:outcome:%' BEGIN SELECT RAISE(ABORT, 'publication outcome failure'); END`);
    const before = test.store.list({ scope: test.record.scope });
    const metrics = test.store.metrics({ scope: test.record.scope });
    expect(() => test.store.recordRunOutcome(test.input)).toThrow(/publication outcome failure/);
    expect(test.store.list({ scope: test.record.scope })).toEqual(before);
    expect(test.store.metrics({ scope: test.record.scope })).toEqual(metrics);
    expect(test.store.outcomeReceipts({ scope: test.record.scope, source: test.consumer })).toEqual([]);
    database.exec('DROP TRIGGER fail_publication_outcome');
    expect(test.store.recordRunOutcome(test.input).receipts).toMatchObject([{ recurrence: true }]);
  });
});

describe('unselected failure collection', () => {
  it('blocks standalone collection for any failure identity after exact selection', () => {
    const test = fixture();
    test.select();
    const before = test.store.list({ scope });
    const metrics = test.store.metrics({ scope });
    expect(test.store.recordUnselectedFailure(test.recurrence)).toBeUndefined();
    expect(test.store.recordUnselectedFailure({ ...test.recurrence, trigger: 'unrelated failure' })).toBeUndefined();
    expect(test.store.list({ scope })).toEqual(before);
    expect(test.store.metrics({ scope })).toEqual(metrics);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
  });

  it('collects a first failure and replays it with retrieved-only context', () => {
    const test = fixture();
    test.select(test.record.id, source, false);
    const input = { ...test.recurrence, trigger: 'new standalone failure' };
    const collected = test.store.recordUnselectedFailure(input)!;
    expect(collected).toMatchObject({ status: 'candidate', occurrences: 1, source });
    expect(test.store.recordUnselectedFailure(input)).toEqual(collected);
    expect(test.store.get(test.record.id, scope)?.status).toBe('verified');
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
  });

  it.each(['scope', 'runId', 'workItemId'] as const)('does not block a different %s', field => {
    const test = fixture();
    test.select();
    const input = field === 'scope' ? { ...test.recurrence, scope: 'github:other/wiki',
      source: { ...source, workItemId: 'github:other/wiki#2' } }
      : { ...test.recurrence, source: { ...source, [field]: field === 'runId' ? 'another-consumer' : `${scope}#3` } };
    const collected = test.store.recordUnselectedFailure(input)!;
    expect(collected.scope).toBe(input.scope);
    expect(collected.observations).toContainEqual(expect.objectContaining({ source: input.source, evidence: input.evidence }));
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
  });

  it('finds an old selected receipt beyond both default and 256-entry slices', () => {
    const test = fixture();
    const selected = test.select();
    test.setTime(later);
    for (let index = 0; index < 3; index++) {
      const record = test.store.recordFailure({ ...test.failure, trigger: `retrieval buffer ${index}` });
      test.store.verify(record.id, { runId: `buffer-qa-${index}`, evidence: [`run:buffer-qa-${index}#passed`] });
      for (let selection = 0; selection < 90; selection++) test.select(record.id, source, false);
    }
    expect(test.store.contextReceipts({ scope, source, limit: 256 })).not.toContainEqual(selected);
    expect(test.store.contextReceipts({ scope, source, limit: 128000 })).toContainEqual(selected);
    const before = test.store.list({ scope });
    expect(test.store.recordUnselectedFailure(test.recurrence)).toBeUndefined();
    expect(test.store.list({ scope })).toEqual(before);
  });

  it.each(['candidate', 'revoked'] as const)('cannot bypass the outcome transaction after the selected asset becomes %s', status => {
    const test = fixture();
    test.select();
    test.store.recordRunOutcome({ scope, source, event: test.event(), failure: test.recurrence });
    if (status === 'revoked') test.store.revoke(test.record.id);
    const before = test.store.get(test.record.id, scope);
    const metrics = test.store.metrics({ scope });
    const receipts = test.store.outcomeReceipts({ scope, source });
    expect(before?.status).toBe(status);
    expect(test.store.recordUnselectedFailure({ ...test.recurrence, evidence: ['run:consumer#extra-failure'] })).toBeUndefined();
    expect(test.store.get(test.record.id, scope)).toEqual(before);
    expect(test.store.metrics({ scope })).toEqual(metrics);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual(receipts);
  });

  it('rolls back aggregation, metrics and source receipts when unselected collection exceeds capacity', () => {
    const test = fixture();
    const snapshot = () => ({ experiences: test.database.prepare('SELECT * FROM experiences ORDER BY id').all(),
      receipts: test.database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all() });
    test.database.prepare("INSERT INTO experience_receipts VALUES (?, 'metric:capacity-padding', 'metric', '')").run(test.record.id);
    const accounted = Number(test.database.prepare(`SELECT COALESCE(SUM(bytes), 0)
      + (SELECT COALESCE(SUM(length(CAST(experience_id AS BLOB)) + length(CAST(source_hash AS BLOB))
        + length(CAST(run_hash AS BLOB)) + length(CAST(evidence_hash AS BLOB)) + 128), 0) FROM experience_receipts)
      + (SELECT COUNT(*) * 256 FROM experience_verifications)
      + (SELECT COALESCE(SUM(length(CAST(payload AS BLOB)) + 256), 0) FROM experience_applicability) AS bytes FROM experiences`).get()!.bytes);
    test.database.prepare("UPDATE experience_receipts SET evidence_hash = ? WHERE source_hash = 'metric:capacity-padding'")
      .run('p'.repeat(8 * 1024 * 1024 - accounted - 16));
    const before = snapshot();
    expect(() => test.store.recordUnselectedFailure(test.recurrence)).toThrow('Experience store capacity exceeded');
    expect(snapshot()).toEqual(before);
    test.database.prepare("DELETE FROM experience_receipts WHERE source_hash = 'metric:capacity-padding'").run();
    expect(test.store.recordUnselectedFailure(test.recurrence)).toMatchObject({ id: test.record.id, status: 'candidate', occurrences: 2 });
  });
});

describe('persistent execution outcomes', () => {
  it('attributes only stored selections from the exact scope, run and work item', () => {
    const test = fixture();
    test.select(test.record.id, { ...source, runId: 'other-run' });
    test.select(test.record.id, { ...source, workItemId: `${scope}#3` });
    test.select(test.record.id, source, false);
    const metrics = test.store.metrics({ scope });
    expect(test.store.recordRunOutcome({ scope, source, event: test.event(), failure: test.recurrence }).receipts).toEqual([]);
    expect(test.store.get(test.record.id, scope)?.occurrences).toBe(1);
    expect(test.store.metrics({ scope })).toEqual(metrics);
    expect(() => test.store.recordRunOutcome({ scope: 'github:other/wiki', source, event: test.event() })).toThrow();
    expect(() => test.store.recordRunOutcome({ scope, source, event: test.event({ runId: 'other-run' }) })).toThrow();
    expect(() => test.store.recordRunOutcome({ scope, source, event: test.event(), failure: test.failure })).toThrow();
  });

  it.each(['occurredAt', 'observedAt'] as const)('rejects attribution when %s does not prove selection preceded the event', timestamp => {
    const test = fixture();
    test.select();
    expect(test.store.recordRunOutcome({ scope, source, event: test.event({ [timestamp]: selectedAt }), failure: test.recurrence }).receipts).toEqual([]);
    expect(test.store.get(test.record.id, scope)?.occurrences).toBe(1);
  });

  it('aggregates once across multiple selections and preserves replay through a cold reopen', () => {
    const test = fixture();
    const first = test.select();
    const second = test.select();
    const input = { scope, source, event: test.event(), failure: test.recurrence };
    const result = test.store.recordRunOutcome(input);
    expect(result.receipts).toHaveLength(2);
    expect(new Set(result.receipts.map(receipt => receipt.selected.selectionId))).toEqual(new Set([first.selectionId, second.selectionId]));
    expect(result.receipts.every(receipt => receipt.recurrence && receipt.benefit === 'unknown')).toBe(true);
    expect(test.store.metrics({ scope }).recurrences).toBe(1);
    expect(test.store.get(test.record.id, scope)?.occurrences).toBe(2);
    test.setTime('2026-11-17T00:00:00.000Z');
    const reopened = new ExperienceStore({ file: test.file });
    stores.push(reopened);
    expect(reopened.recordRunOutcome(input).receipts).toEqual(result.receipts);
    expect(reopened.outcomeReceipts({ scope, source })).toHaveLength(2);
    expect(reopened.metrics({ scope }).recurrences).toBe(1);
    expect(reopened.metrics({ scope }).adoptions).toBe(0);
    expect(reopened.outcomeReceipts({ scope, source: { ...source, workItemId: `${scope}#3` } })).toEqual([]);
  });

  it.each([{ hash: digest('changed') }, { outcome: 'cancelled' as const, type: 'run.finished' as const }, { observedAt: '2026-11-16T00:00:02.000Z' }])(
    'rejects a modified event reusing a persisted sequence: %j', mutation => {
      const test = fixture();
      test.select();
      const original = test.store.recordRunOutcome({ scope, source, event: test.event() });
      expect(() => test.store.recordRunOutcome({ scope, source, event: test.event(mutation) })).toThrow(/conflicts/);
      expect(test.store.outcomeReceipts({ scope, source })).toEqual(original.receipts);
    });

  it('keeps the historical selection after correction, reverification, and revocation', () => {
    const test = fixture();
    const selected = test.select();
    test.store.recordFailure({ ...test.failure, source: { runId: 'other-failure', workItemId: `${scope}#4` }, evidence: ['evidence://other-failure'] });
    test.store.verify(test.record.id, { runId: 'new-qa', evidence: ['evidence://new-regression'] });
    const newer = test.select();
    expect(newer.verificationDigest).not.toBe(selected.verificationDigest);
    test.store.revoke(test.record.id);
    const result = test.store.recordRunOutcome({ scope, source, event: test.event({ type: 'run.finished', outcome: 'succeeded' }) });
    expect(result.receipts.map(receipt => receipt.selected)).toContainEqual(selected);
    expect(result.receipts.map(receipt => receipt.selected)).toContainEqual(newer);
    expect(test.store.get(test.record.id, scope)?.status).toBe('revoked');
  });

  it('records an unrelated failure without attributing recurrence to the selected lesson', () => {
    const test = fixture();
    test.select();
    const result = test.store.recordRunOutcome({ scope, source, event: test.event(),
      failure: { ...test.recurrence, trigger: 'disk full', rootCause: 'logs filled volume', action: 'rotate logs' } });
    expect(result.failure?.id).not.toBe(test.record.id);
    expect(result.receipts).toMatchObject([{ recurrence: false, benefit: 'unknown' }]);
    expect(test.store.get(test.record.id, scope)?.status).toBe('verified');
    expect(test.store.metrics({ scope }).recurrences).toBe(0);
  });

  it.each(['succeeded', 'cancelled', 'failed'] as const)('does not infer adoption, recurrence or benefit from run outcome %s', outcome => {
    const test = fixture();
    test.select();
    const metrics = test.store.metrics({ scope });
    expect(test.store.recordRunOutcome({ scope, source, event: test.event({ type: 'run.finished', outcome }) }).receipts)
      .toMatchObject([{ recurrence: false, benefit: 'unknown' }]);
    expect(test.store.metrics({ scope })).toEqual(metrics);
    expect(JSON.parse(test.store.export({ scope })).experiences[0].receipts).toHaveLength(1);
    expect(() => test.store.verify(test.record.id, { runId: source.runId, evidence: ['evidence://new-independent-qa'] })).not.toThrow();
    expect(() => test.store.recordRunOutcome({ scope, source, event: test.event({ outcome: 'succeeded' }) })).toThrow();
  });

  it('rolls back all selection receipts and recurrence if an insertion fails, then recovers on replay', () => {
    const test = fixture();
    test.select();
    test.select();
    const record = test.store.get(test.record.id, scope);
    const metrics = test.store.metrics({ scope });
    test.database.exec(`CREATE TRIGGER fail_second_outcome BEFORE INSERT ON experience_receipts
      WHEN NEW.source_hash LIKE 'metric:outcome:%' AND EXISTS
      (SELECT 1 FROM experience_receipts WHERE source_hash LIKE 'metric:outcome:%')
      BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END`);
    const input = { scope, source, event: test.event(), failure: test.recurrence };
    expect(() => test.store.recordRunOutcome(input)).toThrow(/injected/);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
    expect(test.store.get(test.record.id, scope)).toEqual(record);
    expect(test.store.metrics({ scope })).toEqual(metrics);
    test.database.exec('DROP TRIGGER fail_second_outcome');
    expect(test.store.recordRunOutcome(input).receipts).toHaveLength(2);
    expect(test.store.metrics({ scope }).recurrences).toBe(1);
  });

  it('bounds receipt capacity and rolls back a simultaneous new failure', () => {
    const test = fixture();
    test.select();
    for (let sequence = 1; sequence <= 256; sequence++) {
      test.store.recordRunOutcome({ scope, source, event: test.event({ sequence, hash: digest(`event-${sequence}`) }) });
    }
    const record = test.store.get(test.record.id, scope);
    expect(() => test.store.recordRunOutcome({ scope, source, event: test.event({ sequence: 257 }), failure: test.recurrence })).toThrow(/limit/);
    expect(test.store.get(test.record.id, scope)).toEqual(record);
    expect(test.store.metrics({ scope }).recurrences).toBe(0);
    expect(test.store.outcomeReceipts({ scope, source })).toHaveLength(256);
    expect(test.store.recordRunOutcome({ scope, source, event: test.event() }).receipts).toHaveLength(1);
  });

  it('rolls back capacity evictions if outcome persistence fails', () => {
    const test = fixture();
    test.select();
    const victim = test.store.recordFailure({ ...test.failure, trigger: 'unrelated candidate' });
    test.database.prepare('INSERT INTO experience_receipts VALUES (?, ?, ?, ?)')
      .run(victim.id, 'metric:test-capacity', 'metric', 'x'.repeat(8 * 1024 * 1024));
    test.database.exec(`CREATE TRIGGER fail_outcome BEFORE INSERT ON experience_receipts
      WHEN NEW.source_hash LIKE 'metric:outcome:%'
      BEGIN SELECT RAISE(ABORT, 'injected outcome failure'); END`);
    expect(() => test.store.recordRunOutcome({ scope, source, event: test.event(), failure: test.recurrence })).toThrow(/injected/);
    expect(test.store.get(victim.id, scope)).toEqual(victim);
    expect(test.store.get(test.record.id, scope)?.occurrences).toBe(1);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
    test.database.exec('DROP TRIGGER fail_outcome');
    expect(test.store.recordRunOutcome({ scope, source, event: test.event(), failure: test.recurrence }).receipts).toHaveLength(1);
    expect(test.store.get(victim.id, scope)).toBeUndefined();
    expect(test.store.get(test.record.id, scope)?.occurrences).toBe(2);
  });

  it('protects every selected experience when global capacity cannot accommodate an outcome', () => {
    const test = fixture();
    test.select();
    const record = test.store.get(test.record.id, scope);
    test.database.prepare('INSERT INTO experience_receipts VALUES (?, ?, ?, ?)')
      .run(test.record.id, 'metric:test-capacity', 'metric', 'x'.repeat(8 * 1024 * 1024));
    expect(() => test.store.recordRunOutcome({ scope, source, event: test.event() })).toThrow(/capacity/);
    expect(test.store.get(test.record.id, scope)).toEqual(record);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
  });
});
