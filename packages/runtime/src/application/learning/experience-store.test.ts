import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperienceStore, experienceContextMatches, type ExperienceContextReceipt, type RecordFailureInput } from './experience-store.js';
import { openSqlite, type SqliteDatabase } from '../../infrastructure/storage/sqlite.js';

const directories: string[] = [];
const stores: ExperienceStore[] = [];
const children: ChildProcess[] = [];
const databases: SqliteDatabase[] = [];
let clock = new Date('2026-11-08T10:00:00.000Z');

function fixture(file?: string) {
  if (!file) {
    const directory = mkdtempSync(join(tmpdir(), 'experience-ledger-'));
    directories.push(directory);
    file = join(directory, 'experience.sqlite');
  }
  const store = new ExperienceStore({ file, now: () => clock });
  stores.push(store);
  return { store, file };
}

function failure(overrides: Partial<RecordFailureInput> = {}): RecordFailureInput {
  return { scope: 'github:owner/wiki', trigger: 'sqlite database locked', rootCause: 'parallel writers skip transaction',
    action: 'use transaction with busy timeout', evidence: ['evidence://failure-1'],
    source: { runId: 'run-failure-1', workItemId: '42' }, ...overrides };
}

function verify(store: ExperienceStore, id: string) {
  return store.verify(id, { runId: 'run-independent-qa', evidence: ['evidence://regression-passed'] });
}

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
  for (const store of stores.splice(0)) store.close();
  for (const database of databases.splice(0)) database.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  clock = new Date('2026-11-08T10:00:00.000Z');
});

describe('local experience ledger', () => {
  describe('execution context receipts', () => {
    function retrieval(record: { id: string; scope: string }) {
      return { id: record.id, scope: record.scope, source: { runId: 'execution-attempt', workItemId: `${record.scope}#99` },
        selectionId: randomUUID(), fragmentDigest: 'a'.repeat(64) };
    }

    it('requires the consuming task to select the reverified version before acknowledging a previously selected lesson', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const input = retrieval(record);
      const adoption = { id: record.id, scope: record.scope, source: input.source };
      const select = (receipt: ExperienceContextReceipt) => store.recordContextSelection({ retrieved: receipt, fragmentDigest: receipt.fragmentDigest });
      const prior = select(store.recordContextRetrieval(input));
      const other = fixture(file).store;
      other.verify(record.id, { runId: 'qa-reverified', evidence: ['run:qa-reverified#passed'] });
      const refreshed = store.recordContextRetrieval({ ...input, selectionId: randomUUID() });
      expect(refreshed.verificationDigest).not.toBe(prior.verificationDigest);
      select(store.recordContextRetrieval({ ...input, selectionId: randomUUID(), source: { ...input.source, workItemId: `${record.scope}#100` } }));
      expect(() => other.adopt(adoption)).toThrow(/selected version/i);
      expect(other.metrics({ scope: record.scope }).adoptions).toBe(0);
      select(refreshed);
      const result = other.adopt(adoption);
      expect(result).toMatchObject({ adoptions: 1, receipt: { verificationDigest: refreshed.verificationDigest } });
      expect(store.adopt(adoption)).toEqual(result);
    });

    it('keeps search separate from execution exposure and persists both stages through a cold reopen', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const input = retrieval(record);
      const query = { scope: record.scope, source: input.source };
      expect(store.recall({ scope: record.scope, prompt: 'sqlite' }).map(entry => entry.id)).toEqual([record.id]);
      expect(store.contextReceipts(query)).toEqual([]);
      const metrics = store.metrics({ scope: record.scope });
      const exchange = store.export({ scope: record.scope });
      const retrieved = store.recordContextRetrieval(input);
      expect(retrieved).toEqual({ version: 1, stage: 'retrieved', experienceId: record.id, scope: record.scope, source: input.source,
        selectionId: input.selectionId, verificationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        contextDigest: createHash('sha256').update('{}').digest('hex'), fragmentDigest: input.fragmentDigest, recordedAt: clock.toISOString() });
      const selected = store.recordContextSelection({ retrieved, fragmentDigest: 'b'.repeat(64) });
      expect(selected).toEqual({ ...retrieved, stage: 'selected', retrievedFragmentDigest: retrieved.fragmentDigest, fragmentDigest: 'b'.repeat(64) });
      expect(store.metrics({ scope: record.scope })).toEqual(metrics);
      expect(store.export({ scope: record.scope })).toBe(exchange);
      const database = openSqlite({ file, schema: '', version: 3 });
      databases.push(database);
      const rows = database.prepare("SELECT source_hash, run_hash, evidence_hash FROM experience_receipts WHERE source_hash LIKE 'metric:context:%' ORDER BY source_hash").all();
      const sourceDigest = createHash('sha256').update(JSON.stringify({ source: input.source, selectionId: input.selectionId })).digest('hex');
      expect(rows.map(row => row.source_hash)).toEqual([`metric:context:retrieved:${sourceDigest}`, `metric:context:selected:${sourceDigest}`]);
      expect(rows.every(row => row.run_hash === createHash('sha256').update(JSON.stringify(input.source.runId)).digest('hex'))).toBe(true);
      const receipts = store.contextReceipts(query);
      expect(receipts).toHaveLength(2);
      expect(receipts).toEqual(expect.arrayContaining([retrieved, selected]));
      clock = new Date(clock.getTime() + 1000);
      store.close();
      const reopened = fixture(file).store;
      expect(reopened.contextReceipts(query)).toEqual(receipts);
      expect(reopened.recordContextRetrieval(input)).toEqual(retrieved);
      expect(reopened.recordContextSelection({ retrieved, fragmentDigest: 'b'.repeat(64) })).toEqual(selected);
      expect(database.prepare("SELECT source_hash, run_hash, evidence_hash FROM experience_receipts WHERE source_hash LIKE 'metric:context:%' ORDER BY source_hash").all()).toEqual(rows);
      expect(reopened.contextReceipts({ ...query, limit: 1 })).toEqual(receipts.slice(0, 1));
      expect(reopened.contextReceipts({ ...query, limit: 0 })).toEqual([]);
      expect(reopened.contextReceipts({ ...query, source: { ...input.source, workItemId: `${record.scope}#100` } })).toEqual([]);
      expect(reopened.contextReceipts({ ...query, source: { ...input.source, runId: 'other-execution' } })).toEqual([]);
    });

    it('requires canonical project identity and matching live applicability without requiring target QA', () => {
      const { store } = fixture();
      const record = store.recordFailure(failure());
      const input = retrieval(record);
      expect(() => store.recordContextRetrieval(input)).toThrow('live verified');
      const actual = { target: { project: record.scope, productVersions: { sqlite: '3.45' }, dirty: false },
        applicability: { environment: 'ci' } };
      store.verify(record.id, { runId: 'qa-applicable', evidence: ['run:qa-applicable#passed'] }, actual);
      for (const context of [undefined, {}, { target: { ...actual.target, productVersions: { sqlite: '3.46' } } },
        { ...actual, target: { ...actual.target, project: 'github:owner/other' } }, Object.create(actual)]) {
        expect(() => store.recordContextRetrieval(input, context)).toThrow('applicability');
      }
      for (const workItemId of ['99', 'github:owner/other#99', 'github:owner/wiki#099']) {
        expect(() => store.recordContextRetrieval({ ...input, source: { ...input.source, workItemId } }, actual)).toThrow();
        expect(() => store.contextReceipts({ scope: record.scope, source: { ...input.source, workItemId } })).toThrow();
      }
      expect(() => store.recordContextRetrieval({ ...input, scope: 'github:owner/other', source: {
        ...input.source, workItemId: 'github:owner/other#99' } }, { target: { project: 'github:owner/other' } })).toThrow('live verified');
      expect(() => store.recordContextRetrieval({ ...input, selectionId: 'not-a-uuid' }, actual)).toThrow();
      expect(() => store.recordContextRetrieval({ ...input, fragmentDigest: 'not-a-sha256' }, actual)).toThrow();
      expect(() => store.recordContextRetrieval(input, null as never)).toThrow();
      expect(store.contextReceipts({ scope: record.scope, source: input.source })).toEqual([]);
      const receipt = store.recordContextRetrieval(input, actual);
      expect(receipt.stage).toBe('retrieved');
      expect(() => store.adopt({ id: record.id, scope: record.scope, source: input.source }, { actual })).toThrow('applicability');
      const adopted = store.adopt({ id: record.id, scope: record.scope, source: input.source }, { actual, verified: actual });
      expect(adopted.receipt).toMatchObject({ version: 2, verificationDigest: receipt.verificationDigest, contextDigest: receipt.contextDigest });
      clock = new Date(Date.parse(record.expiresAt));
      expect(() => store.recordContextRetrieval({ ...input, selectionId: randomUUID() }, actual)).toThrow('live verified');
      expect(store.contextReceipts({ scope: record.scope, source: input.source })).toEqual([receipt]);
    });

    it('accepts an unchanged recalled snapshot and replays it without binding expected metadata into the receipt', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const expectedRecord = store.recall({ scope: record.scope, prompt: 'sqlite' })[0]!;
      expect(expectedRecord.id).toBe(record.id);
      const input = { ...retrieval(record), expectedRecord };
      const other = fixture(file).store;
      const receipt = other.recordContextRetrieval(input);
      expect(receipt).not.toHaveProperty('expectedRecord');
      const metrics = store.metrics({ scope: record.scope });
      clock = new Date(clock.getTime() + 1000);
      expect(store.recordContextRetrieval({ ...input, expectedRecord: { ...expectedRecord,
        source: { workItemId: expectedRecord.source.workItemId, runId: expectedRecord.source.runId } } })).toEqual(receipt);
      expect(() => store.recordContextRetrieval({ ...input, expectedRecord: { ...expectedRecord, id: randomUUID() } }))
        .toThrow('Context retrieval record changed since recall');
      expect(() => store.recordContextRetrieval({ ...input, expectedRecord: { ...expectedRecord, foreign: true } } as never)).toThrow();
      expect(store.contextReceipts({ scope: record.scope, source: input.source })).toEqual([receipt]);
      expect(store.metrics({ scope: record.scope })).toEqual(metrics);
    });

    it('rejects applicability drift with reused QA proof at a fixed clock even when both contexts match the target', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      const required = { target: { project: record.scope, productVersions: { sqlite: '3.45' } } };
      const actual = { target: { ...required.target, conditions: { writer: true } } };
      const proof = { runId: 'qa-fixed-proof', evidence: ['run:qa-fixed-proof#passed'] };
      store.verify(record.id, proof, required);
      const expectedRecord = store.recall({ scope: record.scope, prompt: 'sqlite', ...actual })[0]!;
      expect(expectedRecord.id).toBe(record.id);
      expect(experienceContextMatches(required, actual)).toBe(true);
      expect(experienceContextMatches(actual, actual)).toBe(true);
      const input = { ...retrieval(record), expectedRecord };
      const original = store.recordContextRetrieval(input, actual);
      const other = fixture(file).store;
      const database = openSqlite({ file, schema: '', version: 3 });
      databases.push(database);
      const before = {
        experiences: database.prepare('SELECT * FROM experiences ORDER BY id').all(),
        applicability: database.prepare('SELECT * FROM experience_applicability ORDER BY experience_id').all(),
        verifications: database.prepare('SELECT * FROM experience_verifications ORDER BY experience_id, run_hash, evidence_hash').all(),
        receipts: database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all(),
      };
      expect(() => other.verify(record.id, proof, actual)).toThrow('Changing applicability requires fresh QA evidence');
      for (const reused of [{ ...proof, evidence: ['run:qa-new-proof#passed'] }, { ...proof, runId: 'qa-new-proof' }]) {
        expect(() => other.verify(record.id, reused, actual)).toThrow('Verification requires a fresh run and evidence');
      }
      expect(other.verify(record.id, proof, required)).toEqual(expectedRecord);
      expect(store.get(record.id, record.scope)).toEqual(expectedRecord);
      expect(clock.toISOString()).toBe(expectedRecord.verifiedEvidence?.verifiedAt);
      expect(database.prepare('SELECT * FROM experiences ORDER BY id').all()).toEqual(before.experiences);
      expect(database.prepare('SELECT * FROM experience_applicability ORDER BY experience_id').all()).toEqual(before.applicability);
      expect(database.prepare('SELECT * FROM experience_verifications ORDER BY experience_id, run_hash, evidence_hash').all()).toEqual(before.verifications);
      expect(database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all()).toEqual(before.receipts);
      expect(store.recordContextRetrieval(input, actual)).toEqual(original);
      const next = store.recordContextRetrieval({ ...input, selectionId: randomUUID() }, actual);
      expect(next.verificationDigest).toBe(original.verificationDigest);
      expect(store.contextReceipts({ scope: record.scope, source: input.source })).toHaveLength(2);
    });

    it.each(['verification', 'content', 'applicability'] as const)(
      'rejects a stale recalled snapshot after another connection changes %s without inserting a receipt', change => {
        const { store, file } = fixture();
        const record = store.recordFailure(failure());
        const actual = { target: { project: record.scope, productVersions: { sqlite: '3.45' } } };
        store.verify(record.id, { runId: 'qa-before-recall', evidence: ['run:qa-before-recall#passed'] }, actual);
        const expectedRecord = store.recall({ scope: record.scope, prompt: 'sqlite', ...actual })[0]!;
        expect(expectedRecord.id).toBe(record.id);
        const input = { ...retrieval(record), expectedRecord };
        const other = fixture(file).store;
        const updatedContext = change === 'applicability' ? { target: { ...actual.target, productVersions: { sqlite: '3.46' } } } : actual;
        const updated = other.verify(record.id, { runId: 'qa-after-recall', evidence: ['run:qa-after-recall#passed'],
          ...(change === 'content' ? { action: 'serialize writers before retrying' } : {}) }, updatedContext);
        expect(updated.verifiedEvidence).not.toEqual(expectedRecord.verifiedEvidence);
        if (change !== 'content') expect(updated.fingerprint).toBe(expectedRecord.fingerprint);
        const database = openSqlite({ file, schema: '', version: 3 });
        databases.push(database);
        const rows = database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all();
        const records = database.prepare('SELECT * FROM experiences ORDER BY id').all();
        const metrics = store.metrics({ scope: record.scope });
        expect(() => store.recordContextRetrieval(input, actual)).toThrow('Context retrieval record changed since recall');
        expect(database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all()).toEqual(rows);
        expect(database.prepare('SELECT * FROM experiences ORDER BY id').all()).toEqual(records);
        expect(store.contextReceipts({ scope: record.scope, source: input.source })).toEqual([]);
        expect(store.metrics({ scope: record.scope })).toEqual(metrics);
        const refreshed = store.recall({ scope: record.scope, prompt: 'sqlite', ...updatedContext })[0]!;
        expect(refreshed).toEqual(updated);
        const receipt = store.recordContextRetrieval({ ...input, expectedRecord: refreshed }, updatedContext);
        const adoption = store.adopt({ id: record.id, scope: record.scope, source: input.source }, { actual: updatedContext, verified: updatedContext });
        expect(adoption.receipt).toMatchObject({ version: 2, verificationDigest: receipt.verificationDigest, contextDigest: receipt.contextDigest });
      });

    it('compares the full expected publication snapshot before qualifying or writing a retrieval', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const recalled = store.recall({ scope: record.scope, prompt: 'sqlite' })[0]!;
      expect(recalled.id).toBe(record.id);
      const database = openSqlite({ file, schema: '', version: 3 });
      databases.push(database);
      const publication = { key: '1'.repeat(64), candidateId: '2'.repeat(64), validatedVersion: 1,
        candidateDigest: '3'.repeat(64), evidenceDigest: '4'.repeat(64), validatorVersion: 'validator-1', targetRef: 'wiki:lesson-1' };
      const expectedRecord = { ...recalled, publication };
      const input = { ...retrieval(record), expectedRecord };
      const metrics = store.metrics({ scope: record.scope });
      expect(() => store.recordContextRetrieval(input)).toThrow('Context retrieval record changed since recall');
      for (const field of Object.keys(publication) as (keyof typeof publication)[]) {
        const changed = { ...publication, [field]: field === 'validatedVersion' ? 2
          : field === 'validatorVersion' || field === 'targetRef' ? 'changed' : 'f'.repeat(64) };
        database.prepare('UPDATE experiences SET payload = ? WHERE id = ?').run(JSON.stringify({ ...expectedRecord, publication: changed }), record.id);
        expect(() => store.recordContextRetrieval(input)).toThrow('Context retrieval record changed since recall');
        expect(store.contextReceipts({ scope: record.scope, source: input.source })).toEqual([]);
      }
      expect(store.metrics({ scope: record.scope })).toEqual(metrics);
    });

    it('rejects changed bindings and keeps selection bound to its original version after verification and withdrawal', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const input = retrieval(record);
      const retrieved = store.recordContextRetrieval(input);
      clock = new Date(clock.getTime() + 1000);
      expect(store.recordContextRetrieval(input)).toEqual(retrieved);
      expect(() => store.recordContextRetrieval({ ...input, fragmentDigest: 'b'.repeat(64) })).toThrow('binding');
      expect(() => store.recordContextRetrieval(input, { target: { project: record.scope } })).toThrow('binding');
      store.verify(record.id, { runId: 'qa-new-context-version', evidence: ['run:qa-new-context-version#passed'], action: 'serialize writers' });
      expect(() => store.recordContextRetrieval(input)).toThrow('binding');
      const newer = store.recordContextRetrieval({ ...input, selectionId: randomUUID() });
      expect(newer.verificationDigest).not.toBe(retrieved.verificationDigest);
      store.revoke(record.id);
      expect(() => store.recordContextRetrieval({ ...input, selectionId: randomUUID() })).toThrow('live verified');
      const selected = store.recordContextSelection({ retrieved, fragmentDigest: 'c'.repeat(64) });
      expect(selected).toEqual({ ...retrieved, stage: 'selected', retrievedFragmentDigest: retrieved.fragmentDigest,
        fragmentDigest: 'c'.repeat(64), recordedAt: clock.toISOString() });
      expect(selected.verificationDigest).not.toBe(newer.verificationDigest);
      clock = new Date(clock.getTime() + 1000);
      expect(store.recordContextSelection({ retrieved, fragmentDigest: 'c'.repeat(64) })).toEqual(selected);
      expect(() => store.recordContextSelection({ retrieved, fragmentDigest: 'd'.repeat(64) })).toThrow('binding');
      expect(() => store.recordContextSelection({ retrieved: selected, fragmentDigest: 'c'.repeat(64) })).toThrow('retrieved receipt');
      const query = { scope: record.scope, source: input.source };
      const before = store.contextReceipts(query);
      expect(before).toHaveLength(3);
      store.close();
      expect(fixture(file).store.contextReceipts(query)).toEqual(before);
    });

    it('rejects forged or foreign parents and tampered stored metadata before recording selection', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const input = retrieval(record);
      const retrieved = store.recordContextRetrieval(input);
      const publication = { key: '1'.repeat(64), candidateId: '2'.repeat(64), validatedVersion: 1,
        candidateDigest: '3'.repeat(64), evidenceDigest: '4'.repeat(64), validatorVersion: 'validator-1', targetRef: 'wiki:lesson' };
      const select = (parent: ExperienceContextReceipt) => store.recordContextSelection({ retrieved: parent, fragmentDigest: 'b'.repeat(64) });
      for (const parent of [{ ...retrieved, experienceId: randomUUID() }, { ...retrieved, selectionId: randomUUID() },
        { ...retrieved, scope: 'github:owner/other' }, { ...retrieved, source: { ...retrieved.source, runId: 'other-run' } },
        { ...retrieved, source: { ...retrieved.source, workItemId: `${record.scope}#100` } },
        { ...retrieved, source: { ...retrieved.source, workItemId: 'github:owner/other#99' } },
        { ...retrieved, verificationDigest: 'c'.repeat(64) }, { ...retrieved, contextDigest: 'c'.repeat(64) },
        { ...retrieved, fragmentDigest: 'c'.repeat(64) }, { ...retrieved, publication },
        { ...retrieved, recordedAt: '2026-11-08T11:00:00.000Z' }]) {
        expect(() => select(parent)).toThrow();
      }
      for (const parent of [{ ...retrieved, version: 2 }, { ...retrieved, foreign: true },
        { ...retrieved, retrievedFragmentDigest: 'a'.repeat(64) }]) expect(() => select(parent as never)).toThrow();
      const foreign = fixture().store;
      expect(() => foreign.recordContextSelection({ retrieved, fragmentDigest: 'b'.repeat(64) })).toThrow('original stored');
      const database = openSqlite({ file, schema: '', version: 3 });
      databases.push(database);
      const row = database.prepare("SELECT source_hash, run_hash, evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:context:retrieved:%'").get(record.id)!;
      for (const [runHash, payload] of [['wrong-run', row.evidence_hash], [row.run_hash, '{'],
        ...[{ ...retrieved, version: 2 }, { ...retrieved, experienceId: randomUUID() },
          { ...retrieved, source: { ...retrieved.source, runId: 'other-run' } },
          { ...retrieved, source: { ...retrieved.source, workItemId: `${record.scope}#100` } },
          { ...retrieved, source: { ...retrieved.source, runId: ` ${retrieved.source.runId} ` } },
          { ...retrieved, verificationDigest: 'c'.repeat(64) }, { ...retrieved, contextDigest: 'c'.repeat(64) },
          { ...retrieved, fragmentDigest: 'c'.repeat(64) }, { ...retrieved, publication },
          { ...retrieved, recordedAt: '2026-11-08T11:00:00.000Z' }, { ...retrieved, foreign: true }]
          .map(parent => [row.run_hash, JSON.stringify(parent)])]) {
        database.prepare('UPDATE experience_receipts SET run_hash = ?, evidence_hash = ? WHERE experience_id = ? AND source_hash = ?')
          .run(runHash, payload, record.id, row.source_hash);
        expect(() => select(retrieved)).toThrow();
        expect(database.prepare("SELECT COUNT(*) AS count FROM experience_receipts WHERE source_hash LIKE 'metric:context:selected:%'").get()?.count).toBe(0);
      }
      database.prepare('UPDATE experience_receipts SET run_hash = ?, evidence_hash = ? WHERE experience_id = ? AND source_hash = ?')
        .run(row.run_hash, row.evidence_hash, record.id, row.source_hash);
      expect(select(retrieved).stage).toBe('selected');
    });

    it('preserves all seven historical publication fields without rebinding to a later publication', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const retrieved = store.recordContextRetrieval(retrieval(record));
      const database = openSqlite({ file, schema: '', version: 3 });
      databases.push(database);
      const publication = { key: '1'.repeat(64), candidateId: '2'.repeat(64), validatedVersion: 1,
        candidateDigest: '3'.repeat(64), evidenceDigest: '4'.repeat(64), validatorVersion: 'validator-1', targetRef: 'wiki:lesson-1' };
      const historical = { ...retrieved, publication };
      database.prepare("UPDATE experience_receipts SET evidence_hash = ? WHERE experience_id = ? AND source_hash LIKE 'metric:context:retrieved:%'")
        .run(JSON.stringify(historical), record.id);
      const current = store.get(record.id, record.scope)!;
      database.prepare('UPDATE experiences SET payload = ? WHERE id = ?').run(JSON.stringify({ ...current,
        publication: { ...publication, validatedVersion: 2, candidateDigest: '5'.repeat(64), targetRef: 'wiki:lesson-2' } }), record.id);
      for (const field of Object.keys(publication) as (keyof typeof publication)[]) {
        const changed = { ...publication, [field]: field === 'validatedVersion' ? 2 : field === 'validatorVersion' || field === 'targetRef' ? 'changed' : 'f'.repeat(64) };
        expect(() => store.recordContextSelection({ retrieved: { ...historical, publication: changed }, fragmentDigest: 'b'.repeat(64) })).toThrow('original stored');
      }
      const { targetRef: _targetRef, ...incomplete } = publication;
      expect(() => store.recordContextSelection({ retrieved: { ...historical, publication: incomplete } as never, fragmentDigest: 'b'.repeat(64) })).toThrow();
      const selected = store.recordContextSelection({ retrieved: historical, fragmentDigest: 'b'.repeat(64) });
      expect(selected).toEqual({ ...historical, stage: 'selected', retrievedFragmentDigest: historical.fragmentDigest, fragmentDigest: 'b'.repeat(64) });
      store.close();
      expect(fixture(file).store.contextReceipts({ scope: record.scope, source: historical.source })).toEqual(expect.arrayContaining([historical, selected]));
    });

    it('bounds both stages together at 128 events and allows equivalent replay at capacity', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const firstInput = retrieval(record);
      const first = store.recordContextRetrieval(firstInput);
      const selected = store.recordContextSelection({ retrieved: first, fragmentDigest: 'b'.repeat(64) });
      for (let index = 1; index < 64; index++) {
        const parent = store.recordContextRetrieval({ ...firstInput, selectionId: randomUUID() });
        store.recordContextSelection({ retrieved: parent, fragmentDigest: 'b'.repeat(64) });
      }
      const database = openSqlite({ file, schema: '', version: 3 });
      databases.push(database);
      const rows = database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all();
      const records = database.prepare('SELECT * FROM experiences ORDER BY id').all();
      const metrics = store.metrics({ scope: record.scope });
      expect(store.contextReceipts({ scope: record.scope, source: first.source })).toHaveLength(128);
      expect(() => store.recordContextRetrieval({ ...firstInput, selectionId: randomUUID() })).toThrow('Experience context receipt limit reached (128)');
      clock = new Date(clock.getTime() + 1000);
      expect(store.recordContextRetrieval(firstInput)).toEqual(first);
      expect(store.recordContextSelection({ retrieved: first, fragmentDigest: 'b'.repeat(64) })).toEqual(selected);
      expect(database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all()).toEqual(rows);
      expect(database.prepare('SELECT * FROM experiences ORDER BY id').all()).toEqual(records);
      expect(store.metrics({ scope: record.scope })).toEqual(metrics);
      const another = store.recordFailure(failure({ trigger: 'another capacity-bound asset' }));
      verify(store, another.id);
      const inputs = Array.from({ length: 128 }, () => retrieval(another));
      const parents = inputs.map(input => store.recordContextRetrieval(input));
      expect(() => store.recordContextSelection({ retrieved: parents[0], fragmentDigest: 'b'.repeat(64) })).toThrow('limit reached (128)');
      expect(store.recordContextRetrieval(inputs[0])).toEqual(parents[0]);
    });

    it('rolls back insertion and eviction together at the byte boundary for either stage', () => {
      const { store, file } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const input = retrieval(record);
      const database = openSqlite({ file, schema: '', version: 3 });
      databases.push(database);
      const accountedBytes = () => Number(database.prepare(`SELECT COALESCE(SUM(bytes), 0)
        + (SELECT COALESCE(SUM(length(CAST(experience_id AS BLOB)) + length(CAST(source_hash AS BLOB))
          + length(CAST(run_hash AS BLOB)) + length(CAST(evidence_hash AS BLOB)) + 128), 0) FROM experience_receipts)
        + (SELECT COUNT(*) * 256 FROM experience_verifications)
        + (SELECT COALESCE(SUM(length(CAST(payload AS BLOB)) + 256), 0) FROM experience_applicability) AS bytes FROM experiences`).get()!.bytes);
      let parent: ExperienceContextReceipt | undefined;
      for (const stage of ['retrieved', 'selected'] as const) {
        const victim = store.recordFailure(failure({ trigger: `byte-boundary-victim-${stage}` }));
        database.prepare("INSERT INTO experience_receipts VALUES (?, 'metric:byte-boundary', 'metric', '')").run(victim.id);
        database.prepare("UPDATE experience_receipts SET evidence_hash = ? WHERE experience_id = ? AND source_hash = 'metric:byte-boundary'")
          .run('p'.repeat(8 * 1024 * 1024 - accountedBytes() - 32), victim.id);
        const receipts = store.contextReceipts({ scope: record.scope, source: input.source });
        const metrics = store.metrics({ scope: record.scope });
        const beforeBytes = accountedBytes();
        const write = () => stage === 'retrieved' ? store.recordContextRetrieval(input)
          : store.recordContextSelection({ retrieved: parent!, fragmentDigest: 'b'.repeat(64) });
        database.exec(`CREATE TRIGGER reject_context_eviction AFTER DELETE ON experiences
          BEGIN SELECT RAISE(ABORT, 'simulated context eviction failure'); END;`);
        expect(write).toThrow('simulated context eviction failure');
        expect(accountedBytes()).toBe(beforeBytes);
        expect(store.get(victim.id, victim.scope)).toBeDefined();
        expect(store.contextReceipts({ scope: record.scope, source: input.source })).toEqual(receipts);
        expect(store.metrics({ scope: record.scope })).toEqual(metrics);
        database.exec('DROP TRIGGER reject_context_eviction');
        const result = write();
        if (stage === 'retrieved') parent = result;
        expect(store.get(victim.id, victim.scope)).toBeUndefined();
        expect(accountedBytes()).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(write()).toEqual(result);
        expect(store.metrics({ scope: record.scope })).toEqual(metrics);
      }
    });

    it('excludes context events from recurrence and independent verification provenance', () => {
      const { store } = fixture();
      const record = store.recordFailure(failure());
      verify(store, record.id);
      const input = retrieval(record);
      const retrieved = store.recordContextRetrieval(input);
      store.recordContextSelection({ retrieved, fragmentDigest: 'b'.repeat(64) });
      const recurring = store.recordFailure(failure({ source: input.source, evidence: ['run:execution-attempt#failed'] }));
      expect(recurring.status).toBe('candidate');
      expect(store.metrics({ scope: record.scope })).toEqual({ retrievals: 0, adoptions: 0, recurrences: 1 });
      const another = store.recordFailure(failure({ trigger: 'independent context provenance' }));
      verify(store, another.id);
      const exposure = store.recordContextRetrieval(retrieval(another));
      store.recordContextSelection({ retrieved: exposure, fragmentDigest: 'b'.repeat(64) });
      expect(store.verify(another.id, { runId: exposure.source.runId, evidence: ['run:execution-attempt#passed'] }).status).toBe('verified');
    });
  });

  it('persists a version-bound adoption receipt and replays equivalent contexts without changing its timestamp', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'using-version', workItemId: `${record.scope}#99` } };
    const context = { target: { project: record.scope, runtimeVersions: { node: '22', python: '3' }, conditions: { local: true, remote: false } } };
    const result = store.adopt(adoption, { actual: context });
    expect(result).toMatchObject({ adoptions: 1, receipt: { binding: 'verified-version', experienceId: record.id, scope: record.scope,
      source: adoption.source, version: 2, contextStatus: 'recorded', verificationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/), acknowledgedAt: clock.toISOString() } });
    expect(result.receipt).not.toHaveProperty('publication');
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    const row = database.prepare("SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id)!;
    expect(JSON.parse(String(row.evidence_hash))).toEqual({ version: 2, source: adoption.source,
      verificationDigest: expect.stringMatching(/^[a-f0-9]{64}$/), contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      acknowledgedAt: clock.toISOString() });
    clock = new Date(clock.getTime() + 1000);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.adopt(adoption, { actual: { target: { conditions: { remote: false, local: true },
      runtimeVersions: { python: '3', node: '22' }, project: record.scope } } })).toEqual(result);
    expect(() => reopened.adopt(adoption, { actual: { target: { ...context.target, runtimeVersions: { node: '24', python: '3' } } } })).toThrow(/binding/i);
    expect(reopened.metrics({ scope: record.scope }).adoptions).toBe(1);
    expect(database.prepare("SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id)).toEqual(row);
    expect(() => reopened.adopt(adoption, null as never)).toThrow();
  });

  it('rejects a 65th adoption without changing rows or counts and still replays an existing receipt', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'bounded-consumer-0', workItemId: `${record.scope}#99` } };
    const first = store.adopt(adoption);
    for (let index = 1; index < 64; index++) {
      expect(store.adopt({ ...adoption, source: { ...adoption.source, runId: `bounded-consumer-${index}` } }).adoptions).toBe(index + 1);
    }
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM experience_receipts WHERE source_hash LIKE 'metric:adoption:%'").get()?.count).toBe(64);
    const records = database.prepare('SELECT * FROM experiences ORDER BY id').all();
    const receipts = database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all();
    const counts = store.metrics({ scope: record.scope });
    expect(counts).toEqual({ retrievals: 0, adoptions: 64, recurrences: 0 });
    expect(() => store.adopt({ ...adoption, source: { ...adoption.source, runId: 'bounded-consumer-64' } }))
      .toThrow('Experience adoption limit reached (64)');
    expect(database.prepare('SELECT * FROM experiences ORDER BY id').all()).toEqual(records);
    expect(database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all()).toEqual(receipts);
    expect(store.metrics({ scope: record.scope })).toEqual(counts);
    clock = new Date(clock.getTime() + 1000);
    expect(store.adopt(adoption)).toEqual({ ...first, ...counts });
    expect(database.prepare('SELECT * FROM experiences ORDER BY id').all()).toEqual(records);
    expect(database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all()).toEqual(receipts);
    expect(store.metrics({ scope: record.scope })).toEqual(counts);
  });

  it('replays format 1 receipts unchanged after reopening without inventing persisted source or publication metadata', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'format-one', workItemId: `${record.scope}#99` } };
    store.adopt(adoption);
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    const row = database.prepare("SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id)!;
    const { verificationDigest, contextDigest, acknowledgedAt } = JSON.parse(String(row.evidence_hash));
    const binding = { version: 1, verificationDigest, contextDigest, acknowledgedAt };
    const payload = JSON.stringify(binding);
    database.prepare("UPDATE experience_receipts SET evidence_hash = ? WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").run(payload, record.id);
    store.close();
    clock = new Date(clock.getTime() + 1000);
    const reopened = fixture(file).store;
    const expected = { retrievals: 0, adoptions: 1, recurrences: 0, receipt: { experienceId: record.id, scope: record.scope,
      source: adoption.source, binding: 'verified-version', contextStatus: 'unavailable', ...binding } };
    expect(reopened.adopt(adoption)).toEqual(expected);
    expect(reopened.adopt(adoption)).toEqual(expected);
    expect(database.prepare("SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id))
      .toEqual({ evidence_hash: payload });
  });

  it('checks actual product compatibility consistently before and after successful QA', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'active-products', workItemId: `${record.scope}#99` } };
    const actual = { target: { project: record.scope, revision: 'a'.repeat(40), dirty: false,
      productVersions: { sqlite: '3.45' } } };
    for (const context of [{ actual }, { actual, verified: actual }]) {
      expect(() => store.adopt(adoption, context)).toThrow('applicability');
    }
    expect(store.metrics({ scope: record.scope }).adoptions).toBe(0);
    store.close();
    const reopened = fixture(file).store;
    expect(() => reopened.adopt(adoption, { actual })).toThrow('applicability');
    expect(reopened.metrics({ scope: record.scope }).adoptions).toBe(0);
  });

  it('replays a compatible adoption unchanged as the same target gains successful QA qualification', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'active-compatible', workItemId: `${record.scope}#99` } };
    const actual = { target: { project: record.scope, revision: 'a'.repeat(40), dirty: false, runtimeVersions: { node: '22' } } };
    const original = store.adopt(adoption, { actual });
    expect(store.adopt(adoption, { actual, verified: actual })).toEqual(original);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.adopt(adoption, { actual, verified: actual })).toEqual(original);
    expect(reopened.metrics({ scope: record.scope }).adoptions).toBe(1);
  });

  it('refuses to relabel an adoption after correction and fresh verification', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'using-old-version', workItemId: `${record.scope}#99` } };
    const original = store.adopt(adoption);
    store.verify(record.id, { runId: 'qa-new-version', evidence: ['run:qa-new-version#passed'], action: 'Serialize writers before retrying' });
    expect(() => store.adopt(adoption)).toThrow(/binding/i);
    const current = store.adopt({ ...adoption, source: { ...adoption.source, runId: 'using-new-version' } });
    expect(current.adoptions).toBe(2);
    expect(current.receipt).toMatchObject({ binding: 'verified-version' });
    expect('verificationDigest' in current.receipt && 'verificationDigest' in original.receipt
      && current.receipt.verificationDigest !== original.receipt.verificationDigest).toBe(true);
  });

  it('binds success adoption to verification evidence even when its content fingerprint stays the same', () => {
    const { store } = fixture();
    const input = failure({ source: { runId: 'success-one', workItemId: 'github:owner/wiki#42' } });
    const record = store.recordSuccess(input);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'using-success', workItemId: `${record.scope}#99` } };
    store.adopt(adoption);
    const revised = store.recordSuccess({ ...input, source: { ...input.source, runId: 'success-two' }, evidence: ['run:success-two#passed'] });
    expect(revised.fingerprint).toBe(record.fingerprint);
    expect(() => store.adopt(adoption)).toThrow(/binding/i);
    expect(store.metrics({ scope: record.scope }).adoptions).toBe(1);
  });

  it('does not let adoption receipts suppress recurrence or independent verification', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const source = { runId: 'using-then-failing', workItemId: `${record.scope}#99` };
    store.adopt({ id: record.id, scope: record.scope, source });
    const recurring = store.recordFailure(failure({ source, evidence: ['run:using-then-failing#failed'] }));
    expect(recurring.status).toBe('candidate');
    expect(store.metrics({ scope: record.scope })).toMatchObject({ adoptions: 1, recurrences: 1 });
    const separate = store.recordFailure(failure({ trigger: 'another independent failure' }));
    verify(store, separate.id);
    const independent = { runId: 'adoption-only-run', workItemId: `${record.scope}#100` };
    store.adopt({ id: separate.id, scope: separate.scope, source: independent });
    expect(store.verify(separate.id, { runId: independent.runId, evidence: ['run:adoption-only-run#qa.passed'] }).status).toBe('verified');
  });

  it('reports legacy adoption placeholders as unbound without inventing a version or recounting them', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'legacy-target', workItemId: `${record.scope}#99` } };
    store.adopt(adoption);
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    database.prepare("UPDATE experience_receipts SET run_hash = 'metric', evidence_hash = 'metric' WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").run(record.id);
    expect(store.adopt(adoption)).toEqual({ retrievals: 0, adoptions: 1, recurrences: 0,
      receipt: { binding: 'legacy-unbound', experienceId: record.id, scope: record.scope, source: adoption.source } });
    expect(database.prepare("SELECT run_hash, evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id))
      .toEqual({ run_hash: 'metric', evidence_hash: 'metric' });
    store.close();
    expect(fixture(file).store.adopt(adoption)).toEqual({ retrievals: 0, adoptions: 1, recurrences: 0,
      receipt: { binding: 'legacy-unbound', experienceId: record.id, scope: record.scope, source: adoption.source } });
  });

  it('rejects corrupt and mismatched adoption bindings without changing metrics', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    verify(store, record.id);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'corrupt-target', workItemId: `${record.scope}#99` } };
    store.adopt(adoption);
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    const row = database.prepare("SELECT run_hash, evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id)!;
    const binding = JSON.parse(String(row.evidence_hash));
    const { source: _source, ...withoutSource } = binding;
    const metrics = store.metrics({ scope: record.scope });
    for (const [runHash, payload] of [[row.run_hash, '{'], [row.run_hash, '{}'], ['wrong-run', row.evidence_hash],
      ...[withoutSource, { ...binding, version: 3 }, { ...binding, verificationDigest: '0'.repeat(64) },
        { ...binding, contextDigest: '0'.repeat(64) }, { ...binding, source: { ...adoption.source, runId: 'foreign-run' } },
        { ...binding, source: { ...adoption.source, workItemId: `${record.scope}#100` } },
        { ...binding, source: { runId: adoption.source.runId } }, { ...binding, source: { ...adoption.source, foreign: true } },
        { ...binding, foreign: true }, { ...binding, publication: { key: 'a'.repeat(64), candidateId: 'b'.repeat(64),
          validatedVersion: 2, candidateDigest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64), validatorVersion: 'foreign', targetRef: 'wiki:foreign' } },
      ].map(value => [row.run_hash, JSON.stringify(value)])]) {
      database.prepare("UPDATE experience_receipts SET run_hash = ?, evidence_hash = ? WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'")
        .run(runHash, payload, record.id);
      expect(() => store.adopt(adoption)).toThrow();
      expect(store.metrics({ scope: record.scope })).toEqual(metrics);
    }
    database.prepare("UPDATE experience_receipts SET run_hash = ?, evidence_hash = ? WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'")
      .run(row.run_hash, row.evidence_hash, record.id);
    expect(store.adopt(adoption).adoptions).toBe(1);
  });

  it('requires matching verified applicability before counting or replaying an adoption', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    const context = { applicability: { version: 'asset-2', environment: 'ci' }, target: { project: record.scope,
      revision: 'a'.repeat(40), dirty: false, productVersions: { sqlite: '3.45' }, conditions: { writer: true } } };
    store.verify(record.id, { runId: 'qa-adoption', evidence: ['run:qa-adoption#qa.passed'] }, context);
    const adoption = { id: record.id, scope: record.scope, source: { runId: 'using-run', workItemId: `${record.scope}#99` } };
    const mismatches = [undefined, {}, { target: context.target },
      { ...context, applicability: { ...context.applicability, environment: 'production' } },
      { ...context, target: { ...context.target, revision: 'b'.repeat(40) } },
      { ...context, target: { ...context.target, dirty: true } },
      { ...context, target: { ...context.target, project: 'github:other/wiki' } },
      { ...context, target: { ...context.target, productVersions: { sqlite: '3.46' } } },
      { ...context, target: { ...context.target, conditions: Object.create({ writer: true }) } },
      Object.create(context)];
    for (const actual of mismatches) expect(() => store.adopt(adoption, { actual: actual ?? {}, verified: actual })).toThrow('applicability');
    expect(() => store.adopt(adoption, { actual: context })).toThrow('applicability');
    expect(() => store.adopt(adoption, { actual: { ...context, target: { ...context.target, revision: 'b'.repeat(40) } }, verified: context })).toThrow('applicability');
    expect(store.metrics({ scope: record.scope }).adoptions).toBe(0);
    expect(store.adopt(adoption, { actual: context, verified: context }).adoptions).toBe(1);
    for (const actual of mismatches) expect(() => store.adopt(adoption, { actual: actual ?? {}, verified: actual })).toThrow('applicability');
    expect(store.adopt(adoption, { actual: context, verified: context }).adoptions).toBe(1);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.adopt(adoption, { actual: context, verified: context }).adoptions).toBe(1);
    expect(() => reopened.adopt(adoption)).toThrow('applicability');
  });

  it('recalls a verified diagnostic by root-cause terms without requiring its opaque trigger code', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger: 'agent_process_failed',
      rootCause: 'the agent process failed with exit code 23: simulated agent process failure',
      action: 'Check deterministic subprocess exit status and use bounded retries' }));
    const query = { scope: record.scope, prompt: 'simulated agent matrix' };
    expect(store.recall(query)).toEqual([]);
    verify(store, record.id);
    expect(store.recall(query).map(entry => entry.id)).toEqual([record.id]);
    expect(store.recall({ ...query, scope: 'github:other/wiki' })).toEqual([]);
    expect(store.recall({ ...query, prompt: 'unrelated browser rendering' })).toEqual([]);
    for (const prompt of ['No simulated agent process failure; only rename matrix heading.',
      'The simulated agent process failure is absent; only rename matrix heading.',
      'No simulated agent process failure; only document subprocess exit status.',
      'The simulated agent process failure is absent; only rename the agent process heading.']) {
      expect(store.recall({ ...query, prompt }), prompt).toEqual([]);
    }
  });

  it.each([
    ['server crashes', 'No error handler is installed'],
    ['worker crashes', 'No fault tolerance is configured'],
  ])('recalls %s when the query states its actual missing protection', (trigger, rootCause) => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger, rootCause, action: 'install the missing protection' }));
    verify(store, record.id);
    for (const condition of [rootCause, rootCause.replace(' is ', ' ')]) {
      expect(store.recall({ scope: record.scope, prompt: `${trigger}; ${condition}` }).map(entry => entry.id)).toEqual([record.id]);
    }
  });

  it('rejects an explicitly absent error even when its root cause describes an absent single-writer case', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger: 'SQLITE_BUSY during transaction commit',
      rootCause: 'SQLITE_BUSY is absent with one writer but recurs with concurrent writers',
      action: 'Serialize concurrent writers before retrying the transaction' }));
    verify(store, record.id);
    expect(store.recall({ scope: record.scope, prompt: 'SQLITE_BUSY is absent; only rename heading.' })).toEqual([]);
  });

  it('does not confuse an absent fault with an absent fault handler', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger: 'server crashes', rootCause: 'No server error handler is installed',
      action: 'install the missing protection' }));
    verify(store, record.id);
    for (const prompt of ['No server error; only update error handler documentation.',
      'The server error is absent; only update error handler documentation.']) {
      expect(store.recall({ scope: record.scope, prompt }), prompt).toEqual([]);
    }
  });

  it('recalls missing error-log files described with either absence wording', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger: 'error log file is absent', rootCause: 'the error log file was deleted',
      action: 'restore the error log file before retrying logging' }));
    verify(store, record.id);
    for (const prompt of ['No error log file; restore logging.', 'The error log file is absent; restore logging.']) {
      expect(store.recall({ scope: record.scope, prompt }).map(entry => entry.id), prompt).toEqual([record.id]);
    }
  });

  it('requires own trusted applicability fields and never accepts inherited conditions or versions', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure());
    const context = { target: { project: record.scope, dirty: false, productVersions: { sqlite: '3.45' }, conditions: { writer: true } } };
    store.verify(record.id, { runId: 'qa-own', evidence: ['run:qa-own#test'] }, context);
    const query = { scope: record.scope, prompt: 'sqlite locked', ...context };
    expect(store.recall(query).map(entry => entry.id)).toEqual([record.id]);
    for (const target of [
      { ...context.target, conditions: {} },
      { ...context.target, conditions: Object.create({ writer: true }) },
      { ...context.target, productVersions: Object.create({ sqlite: '3.45' }) },
      Object.assign(Object.create({ project: record.scope }), { dirty: false, productVersions: { sqlite: '3.45' }, conditions: { writer: true } }),
    ]) {
      expect(experienceContextMatches(context, { target })).toBe(false);
      expect(store.recall({ ...query, target })).toEqual([]);
    }
    expect(experienceContextMatches({ applicability: { environment: 'ci' } },
      { applicability: Object.create({ environment: 'ci' }) })).toBe(false);
    expect(experienceContextMatches(context, Object.create(context))).toBe(false);
  });

  it('binds structured applicability to independent verification and fails closed without exact trusted fields', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure({ action: 'use busy timeout; validated only on SQLite 3.45',
      source: { runId: 'failure-bounded', workItemId: 'github:owner/wiki#42' } }));
    const context = { applicability: { version: 'asset-2', environment: 'ci' }, target: { project: record.scope,
      revision: 'a'.repeat(40), dirty: false, productVersions: { sqlite: '3.45' }, conditions: { writer: true } } };
    const proof = { runId: 'qa-bounded', evidence: ['run:qa-bounded#qa.passed'] };
    store.verify(record.id, proof, context);
    const query = { scope: record.scope, prompt: 'sqlite locked on Node 22.16', ...context };
    expect(store.recall(query).map(entry => entry.id)).toEqual([record.id]);
    for (const target of [undefined, { ...context.target, revision: undefined }, { ...context.target, dirty: true },
      { ...context.target, project: 'github:other/payments' }, { ...context.target, productVersions: {} },
      { ...context.target, productVersions: { sqlite: '3.46' } }, { ...context.target, conditions: { writer: false } },
      { ...context.target, revision: 'b'.repeat(40) }]) {
      expect(store.recall({ ...query, target })).toEqual([]);
    }
    expect(store.recall({ ...query, applicability: undefined })).toEqual([]);
    expect(store.recall({ ...query, applicability: { ...context.applicability, environment: 'production' } })).toEqual([]);
    expect(store.recall({ ...query, applicability: { ...context.applicability, version: 'asset-3' } })).toEqual([]);
    expect(() => store.verify(record.id, proof)).toThrow('applicability');
    expect(JSON.parse(store.export({ scope: record.scope })).experiences).toEqual([]);
    expect(() => store.copy({ id: record.id, scope: record.scope, targetScope: 'github:other/payments' })).toThrow('applicability');
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.recall(query).map(entry => entry.id)).toEqual([record.id]);
    reopened.revoke(record.id);
    expect(reopened.recall(query)).toEqual([]);
  });

  it('uses trusted project over prompt mentions and separates product, runtime and knowledge asset versions', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger: 'HTTP429 TS2322 SQLITE_BUSY', action: 'retry with busy timeout' }));
    const target = { project: record.scope, revision: 'a'.repeat(40), dirty: false,
      productVersions: { sqlite: '3.45' }, runtimeVersions: { node: '22.16' } };
    store.verify(record.id, { runId: 'qa-versions', evidence: ['run:qa-versions#qa.passed'] }, { target });
    const query = { scope: record.scope, prompt: 'HTTP429 TS2322 SQLITE_BUSY in github:other/payments on Node 99', target };
    expect(store.recall(query).map(entry => entry.id)).toEqual([record.id]);
    expect(store.recall({ ...query, applicability: { version: '99' } }).map(entry => entry.id)).toEqual([record.id]);
    expect(store.recall({ ...query, target: { ...target, runtimeVersions: undefined } })).toEqual([]);
    expect(store.recall({ ...query, target: { ...target, productVersions: { sqlite: '22.16' }, runtimeVersions: { node: '3.45' } } })).toEqual([]);
    expect(store.recall({ ...query, target: { ...target, project: 'github:other/payments' } })).toEqual([]);
  });

  it('retains constraints after recurrence and cannot reverify them as unrestricted', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure());
    const context = { target: { project: record.scope, revision: 'a'.repeat(40), dirty: false } };
    store.verify(record.id, { runId: 'qa-first', evidence: ['run:qa-first#test'] }, context);
    store.recordFailure(failure({ source: { runId: 'recurrence', workItemId: '43' }, evidence: ['run:recurrence#failure'] }));
    expect(store.recall({ scope: record.scope, prompt: 'sqlite', ...context })).toEqual([]);
    expect(() => store.verify(record.id, { runId: 'qa-next', evidence: ['run:qa-next#test'] })).toThrow('applicability');
    store.verify(record.id, { runId: 'qa-next', evidence: ['run:qa-next#test'] }, context);
    expect(store.recall({ scope: record.scope, prompt: 'sqlite', ...context }).map(entry => entry.id)).toEqual([record.id]);
    clock = new Date('2027-11-08T10:00:00.000Z');
    expect(store.recall({ scope: record.scope, prompt: 'sqlite', ...context })).toEqual([]);
  });

  it('adds applicability storage to v2 without changing legacy records or version-one exchange', () => {
    const { store, file } = fixture();
    const record = verify(store, store.recordFailure(failure()).id);
    const exchange = store.export({ scope: record.scope });
    store.close();
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    database.exec('DROP TABLE experience_applicability; PRAGMA user_version = 2;');
    const migrated = fixture(file).store;
    expect(migrated.get(record.id, record.scope)).toEqual(record);
    expect(migrated.export({ scope: record.scope })).toBe(exchange);
    expect(migrated.recall({ scope: record.scope, prompt: 'sqlite' })).toEqual([record]);
    expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
  });

  it('does not infer applicability from a legacy action or promote invalid structured assertions', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ action: 'set timeout; validated only on SQLite 3.45' }));
    const proof = { runId: 'qa-invalid', evidence: ['run:qa-invalid#test'] };
    for (const target of [{ project: record.scope, revision: 'invalid', dirty: false },
      { project: 'github:other/payments', revision: 'a'.repeat(40), dirty: false }]) {
      expect(() => store.verify(record.id, proof, { target })).toThrow();
      expect(store.get(record.id, record.scope)?.status).toBe('candidate');
    }
    verify(store, record.id);
    expect(store.recall({ scope: record.scope, prompt: 'sqlite', target: { project: record.scope,
      revision: 'a'.repeat(40), dirty: false, productVersions: { sqlite: '3.45' } } })).toEqual([]);
  });

  it('persists candidates on disk and idempotently deduplicates a fingerprint with provenance', () => {
    const { store, file } = fixture();
    const first = store.recordFailure(failure());
    expect(store.recordFailure(failure())).toEqual(first);
    const repeated = store.recordFailure(failure({ source: { runId: 'run-failure-2', workItemId: '43' }, evidence: ['evidence://failure-2'] }));
    expect(repeated).toMatchObject({ id: first.id, fingerprint: first.fingerprint, status: 'candidate', occurrences: 2, source: first.source });
    expect(repeated.evidence).toEqual(['evidence://failure-1', 'evidence://failure-2']);
    expect(repeated.observations).toEqual([
      { source: first.source, evidence: ['evidence://failure-1'], recordedAt: clock.toISOString() },
      { source: { runId: 'run-failure-2', workItemId: '43' }, evidence: ['evidence://failure-2'], recordedAt: clock.toISOString() },
    ]);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.list({ scope: first.scope })).toEqual([repeated]);
    expect(reopened.recall({ scope: first.scope, prompt: 'sqlite locked' })).toEqual([]);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each([
    ['path', '/srv/fixture/first/cache.sqlite', '/srv/fixture/second/cache.sqlite'],
    ['ip', '192.0.2.41', '192.0.2.42'],
    ['url', 'https://fixture.invalid/first', 'https://fixture.invalid/second'],
  ])('preserves exact %s failure identity across verification, recurrence and reopening', (_kind, first, second) => {
    const { store, file } = fixture();
    const original = failure({ trigger: 'qa_execution_failed', rootCause: `Cannot access ${first}`,
      action: 'Inspect the qa_execution_failed evidence and validate a correction before retrying.' });
    const record = store.recordFailure(original);
    verify(store, record.id);
    const unrelated = store.recordFailure({ ...original, rootCause: `Cannot access ${second}`,
      source: { runId: 'different-raw-diagnostic', workItemId: '43' }, evidence: ['run:different-raw-diagnostic#qa.failed'] });
    expect(unrelated.id).not.toBe(record.id);
    expect(store.get(record.id, record.scope)?.status).toBe('verified');
    store.close();
    const reopened = fixture(file).store;
    const recurring = reopened.recordFailure({ ...original, source: { runId: 'same-raw-diagnostic', workItemId: '44' },
      evidence: ['run:same-raw-diagnostic#qa.failed'] });
    expect(recurring).toMatchObject({ id: record.id, status: 'candidate', occurrences: 2,
      failureIdentity: { rootCause: original.rootCause } });
    expect(reopened.metrics({ scope: record.scope })).toMatchObject({ recurrences: 1, adoptions: 0 });
    expect(reopened.recordFailure({ ...original, source: { runId: 'same-raw-diagnostic', workItemId: '44' },
      evidence: ['run:same-raw-diagnostic#qa.failed'] })).toEqual(recurring);
  });

  it('requires explicit independent verification and new evidence, then persists promotion and revocation', () => {
    const { store, file } = fixture();
    const record = store.recordFailure(failure());
    expect(() => store.verify(record.id, { runId: record.source.runId, evidence: ['evidence://passed'] })).toThrow('independent run');
    expect(() => store.verify(record.id, { runId: 'qa', evidence: record.evidence })).toThrow('new evidence');
    const verified = verify(store, record.id);
    expect(verified).toMatchObject({ status: 'verified', verifiedEvidence: { runId: 'run-independent-qa', evidence: ['evidence://regression-passed'] } });
    expect(verify(store, record.id)).toEqual(verified);
    expect(store.recordFailure(failure())).toEqual(verified);
    expect(store.recordFailure(failure({ source: { runId: 'replayed-report-run', workItemId: '42' } })).status).toBe('verified');
    expect(store.recordFailure(failure({ evidence: ['evidence://late-detail'] })).status).toBe('verified');
    const retained = store.get(record.id, record.scope)!;
    expect(store.recall({ scope: record.scope, prompt: 'sqlite locked' })).toEqual([retained]);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.recall({ scope: record.scope, prompt: 'sqlite locked' })).toEqual([retained]);
    const revoked = reopened.revoke(record.id);
    expect(reopened.revoke(record.id)).toEqual(revoked);
    expect(revoked.verifiedEvidence).toEqual(verified.verifiedEvidence);
    expect(reopened.recall({ scope: record.scope, prompt: 'sqlite locked' })).toEqual([]);
    expect(() => verify(reopened, record.id)).toThrow('Revoked');
    expect(reopened.recordFailure(failure({ source: { runId: 'another-failure', workItemId: '42' } })))
      .toMatchObject({ status: 'revoked', verifiedEvidence: verified.verifiedEvidence });
  });

  it('allows evidence-backed action and root cause correction with coherent fingerprint and atomic collision handling', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ action: 'Inspect SQLITE_BUSY evidence before retry' }));
    const corrected = store.verify(record.id, { evidence: ['evidence://regression-passed'], runId: 'qa',
      action: 'use BEGIN IMMEDIATE and busy_timeout', rootCause: 'missing writer serialization' });
    expect(corrected).toMatchObject({ id: record.id, status: 'verified', action: 'use BEGIN IMMEDIATE and busy_timeout', rootCause: 'missing writer serialization' });
    expect(corrected.fingerprint).not.toBe(record.fingerprint);
    expect(store.recordFailure(failure({ action: corrected.action, rootCause: corrected.rootCause })).id).toBe(record.id);
    const another = store.recordFailure(failure({ action: 'different repair' }));
    expect(() => store.verify(another.id, { evidence: ['evidence://another-qa'], runId: 'qa',
      action: corrected.action, rootCause: corrected.rootCause })).toThrow('already exists');
    expect(store.list({ scope: record.scope })).toHaveLength(2);
    expect(store.list({ scope: record.scope }).find(entry => entry.id === another.id)).toEqual(another);
  });

  it('expires verified records at the exact UTC boundary and requires fresh verification after another failure', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ expiresAt: '2026-11-08T10:00:01Z' }));
    expect(record.expiresAt).toBe('2026-11-08T10:00:01.000Z');
    verify(store, record.id);
    clock = new Date('2026-11-08T10:00:01.000Z');
    expect(store.recall({ scope: record.scope, prompt: 'sqlite locked' })).toEqual([]);
    expect(() => verify(store, record.id)).toThrow('Expired');
    expect(store.recordFailure(failure({ expiresAt: '2026-11-08T10:00:01Z' })).expiresAt).toBe(record.expiresAt);
    const renewed = store.recordFailure(failure({ source: { runId: 'fresh-failure', workItemId: '42' }, evidence: ['evidence://fresh-failure'] }));
    expect(renewed).toMatchObject({ id: record.id, status: 'candidate', occurrences: 2 });
    expect(renewed.verifiedEvidence).toBeUndefined();
    store.verify(renewed.id, { runId: 'fresh-independent-qa', evidence: ['evidence://fresh-regression-passed'] });
    const failedAgain = store.recordFailure(failure({ source: { runId: 'new-failing-run', workItemId: '42' }, evidence: ['evidence://new-failure'] }));
    expect(failedAgain.status).toBe('candidate');
    expect(store.recall({ scope: record.scope, prompt: 'sqlite' })).toEqual([]);
  });

  it.each(['trigger', 'rootCause', 'action'] as const)('requires the complete failure identity rather than a shared summary when %s differs', field => {
    const { store } = fixture();
    const original = failure();
    const record = store.recordFailure(original);
    const verified = verify(store, record.id);
    const other = store.recordFailure({ ...original, [field]: `different ${original[field]}`,
      source: { runId: 'different-failure', workItemId: '43' }, evidence: ['evidence://different-failure'] });
    expect(other.id).not.toBe(record.id);
    expect(store.get(record.id, record.scope)).toEqual(verified);
    expect(store.metrics({ scope: record.scope }).recurrences).toBe(0);
  });

  it('keeps the original failure identity after correcting advice and withdraws advice when that failure recurs', () => {
    const { store } = fixture();
    const original = failure({ action: 'Inspect the failure evidence before retrying' });
    const candidate = store.recordFailure(original);
    const verified = store.verify(candidate.id, { runId: 'independent-qa', evidence: ['run:independent-qa#passed'], action: 'Use BEGIN IMMEDIATE with bounded retries', rootCause: 'transaction serialization was missing' });
    expect(store.recordFailure(original).status).toBe('verified');
    const recurrence = store.recordFailure({ ...original, source: { ...original.source, runId: 'new-failed-run' }, evidence: ['run:new-failed-run#failure'] });
    expect(recurrence).toMatchObject({ id: candidate.id, fingerprint: verified.fingerprint, status: 'candidate', occurrences: 2 });
    expect(store.list({ scope: original.scope })).toHaveLength(1);
    expect(store.recall({ scope: original.scope, prompt: 'sqlite transaction' })).toEqual([]);
  });

  it('fails closed for legacy corrected records whose original identity fields are unavailable', () => {
    const { store, file } = fixture();
    const original = failure();
    const record = store.recordFailure(original);
    const corrected = store.verify(record.id, { runId: 'legacy-qa', evidence: ['run:legacy-qa#passed'], rootCause: 'corrected cause', action: 'corrected action' });
    const legacy = { ...corrected };
    delete legacy.failureIdentity;
    const payload = JSON.stringify(legacy);
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    database.prepare('UPDATE experiences SET payload = ?, bytes = ? WHERE id = ?').run(payload, Buffer.byteLength(payload), record.id);
    expect(() => store.export({ scope: original.scope })).toThrow('Original failure identity is unavailable');
    expect(() => store.copy({ id: record.id, scope: original.scope, targetScope: 'github:owner/target' })).toThrow('Original failure identity is unavailable');
    expect(store.recordFailure({ ...original, source: { ...original.source, runId: 'legacy-recurrence' }, evidence: ['run:legacy-recurrence#qa.failed'] }))
      .toMatchObject({ id: record.id, status: 'candidate' });
  });

  it('rejects reused verification runs and evidence after recurrence, including after reopening', () => {
    const { store, file } = fixture();
    const original = failure();
    const candidate = store.recordFailure(original);
    const firstProof = { runId: 'qa-1', evidence: ['evidence://qa-1-b', 'evidence://qa-1-a'], action: 'Use BEGIN IMMEDIATE' };
    const secondProof = { runId: 'qa-2', evidence: ['evidence://qa-2'] };
    const verified = store.verify(candidate.id, firstProof);
    expect(store.verify(candidate.id, firstProof)).toEqual(verified);
    store.recordFailure({ ...original, source: { ...original.source, runId: 'recurrence-1' }, evidence: ['evidence://recurrence-1'] });
    expect(() => store.verify(candidate.id, firstProof)).toThrow('fresh');
    expect(() => store.verify(candidate.id, { ...firstProof, evidence: ['evidence://different-proof'] })).toThrow('fresh');
    expect(() => store.verify(candidate.id, { runId: 'renamed-qa', evidence: [...firstProof.evidence].reverse() })).toThrow('fresh');
    store.verify(candidate.id, secondProof);
    store.recordFailure({ ...original, source: { ...original.source, runId: 'recurrence-2' }, evidence: ['evidence://recurrence-2'] });
    store.close();
    const reopened = fixture(file).store;
    expect(() => reopened.verify(candidate.id, firstProof)).toThrow('fresh');
    expect(() => reopened.verify(candidate.id, secondProof)).toThrow('fresh');
    expect(reopened.recall({ scope: original.scope, prompt: 'sqlite' })).toEqual([]);
    expect(reopened.verify(candidate.id, { runId: 'qa-3', evidence: ['evidence://qa-3'] }).status).toBe('verified');
    expect(reopened.list({ scope: original.scope })).toHaveLength(1);
  });

  it('migrates existing verification evidence into durable replay guards', () => {
    const { store, file } = fixture();
    const candidate = store.recordFailure(failure());
    const proof = { runId: 'legacy-qa', evidence: ['evidence://legacy-proof'] };
    const verified = store.verify(candidate.id, proof);
    store.close();
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    database.exec('DROP TABLE experience_verifications; DROP TABLE experience_applicability; PRAGMA user_version = 1;');
    const migrated = fixture(file).store;
    expect(migrated.verify(candidate.id, proof)).toEqual(verified);
    migrated.recordFailure(failure({ source: { runId: 'after-migration', workItemId: '42' }, evidence: ['evidence://after-migration'] }));
    expect(() => migrated.verify(candidate.id, proof)).toThrow('fresh');
    expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(3);
    expect(database.prepare('SELECT COUNT(*) AS count FROM experience_verifications').get()?.count).toBe(1);
  });

  it('bounds verification history without evicting replay guards or partially promoting a candidate', () => {
    const { store, file } = fixture();
    const candidate = store.recordFailure(failure());
    for (let index = 0; index < 256; index++) store.verify(candidate.id, { runId: `qa-${index}`, evidence: [`evidence://qa-${index}`] });
    const verified = store.get(candidate.id, candidate.scope)!;
    expect(store.verify(candidate.id, { runId: 'qa-255', evidence: ['evidence://qa-255'] })).toEqual(verified);
    const recurrence = store.recordFailure(failure({ source: { runId: 'after-verification-limit', workItemId: '42' }, evidence: ['evidence://recurrence'] }));
    expect(() => store.verify(candidate.id, { runId: 'qa-overflow', evidence: ['evidence://qa-overflow'] })).toThrow('verification limit');
    expect(() => store.verify(candidate.id, { runId: 'qa-0', evidence: ['evidence://qa-0'] })).toThrow('fresh');
    expect(store.get(candidate.id, candidate.scope)).toEqual(recurrence);
    expect(store.recall({ scope: candidate.scope, prompt: 'sqlite' })).toEqual([]);
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    expect(database.prepare('SELECT COUNT(*) AS count FROM experience_verifications').get()?.count).toBe(256);
  });

  it('matches exact canonical project scope, including SQL metacharacters, without cross-project recall', () => {
    const { store } = fixture();
    const first = store.recordFailure(failure());
    const other = store.recordFailure(failure({ scope: 'github:owner/wiki-other' }));
    const sql = store.recordFailure(failure({ scope: "github:owner/' OR 1=1 --" }));
    for (const record of [first, other, sql]) verify(store, record.id);
    for (const record of [first, other, sql]) {
      expect(store.get(record.id, record.scope)?.id).toBe(record.id);
      expect(store.list({ scope: record.scope }).map(entry => entry.id)).toEqual([record.id]);
      expect(store.recall({ scope: record.scope, prompt: 'sqlite' }).map(entry => entry.id)).toEqual([record.id]);
    }
    expect(store.get(first.id, other.scope)).toBeUndefined();
    expect(store.get(other.id, first.scope)).toBeUndefined();
    expect(store.get(first.id, 'github:owner')).toBeUndefined();
    expect(() => store.get('invalid-id', first.scope)).toThrow();
    expect(() => store.get(first.id, '')).toThrow();
    expect(store.recall({ scope: 'github:owner', prompt: 'sqlite' })).toEqual([]);
    expect(first.fingerprint).not.toBe(other.fingerprint);
  });

  it('ranks relevance, excludes candidates and irrelevant text, and respects result and serialized character budgets', () => {
    const { store } = fixture();
    const less = store.recordFailure(failure({ trigger: 'sqlite query', rootCause: 'read error', action: 'inspect journal' }));
    const best = store.recordFailure(failure());
    const unrelated = store.recordFailure(failure({ trigger: 'network refused', rootCause: 'wrong port', action: 'fix endpoint' }));
    store.recordFailure(failure({ trigger: 'sqlite locked busy timeout candidate' }));
    for (const record of [less, best, unrelated]) verify(store, record.id);
    const recalled = store.recall({ scope: best.scope, prompt: 'please fix sqlite locked busy timeout', limit: 2 });
    expect(recalled.map(record => record.id)).toEqual([best.id, less.id]);
    const cap = JSON.stringify([recalled[0]]).length;
    expect(store.recall({ scope: best.scope, prompt: 'sqlite', maxChars: cap })).toHaveLength(1);
    expect(JSON.stringify(store.recall({ scope: best.scope, prompt: 'sqlite', maxChars: cap })).length).toBeLessThanOrEqual(cap);
    expect(store.recall({ scope: best.scope, prompt: 'sqlite', maxChars: 20 })).toEqual([]);
    expect(store.recall({ scope: best.scope, prompt: 'please and the' })).toEqual([]);
    expect(store.recall({ scope: best.scope, prompt: 'sql' })).toEqual([]);
    expect(store.recall({ scope: best.scope, prompt: 'sqlite', limit: 0 })).toEqual([]);
    expect(store.list({ scope: best.scope, status: 'candidate' })).toHaveLength(1);
    expect(store.list({ scope: best.scope, limit: 0 })).toEqual([]);
  });

  it('recalls single-word root causes and actions behind an opaque trigger', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger: 'network.failure',
      rootCause: 'network timeout', action: 'configure proxy' }));
    expect(store.recall({ scope: record.scope, prompt: 'network' })).toEqual([]);
    verify(store, record.id);
    for (const prompt of ['network', 'timeout', 'proxy']) {
      expect(store.recall({ scope: record.scope, prompt }).map(entry => entry.id), prompt).toEqual([record.id]);
    }
    for (const prompt of ['net', 'No network', 'network is absent']) {
      expect(store.recall({ scope: record.scope, prompt }), prompt).toEqual([]);
    }
    expect(store.recall({ scope: 'github:owner/other', prompt: 'network' })).toEqual([]);
    store.revoke(record.id);
    expect(store.recall({ scope: record.scope, prompt: 'network' })).toEqual([]);
  });

  it('keeps CLI option and error identifiers intact beside Chinese prose', () => {
    const { store } = fixture();
    const option = store.recordFailure(failure({ trigger: 'afk experience record --root-cause',
      rootCause: 'required option omitted', action: 'provide the established cause' }));
    const error = store.recordFailure(failure({ trigger: 'ERR_MODULE_NOT_FOUND',
      rootCause: '包尚未构建', action: '先构建工作区包再导入' }));
    for (const record of [option, error]) verify(store, record.id);
    expect(store.recall({ scope: option.scope, prompt: '缺少--root-cause选项' }).map(record => record.id)).toEqual([option.id]);
    expect(store.recall({ scope: option.scope, prompt: '--root-dir' })).toEqual([]);
    expect(store.recall({ scope: error.scope, prompt: '导入时出现ERR_MODULE_NOT_FOUND怎么办？' }).map(record => record.id)).toEqual([error.id]);
    expect(store.recall({ scope: error.scope, prompt: 'ERR_MODULE_NOT_FOUND_EXTRA' })).toEqual([]);
    const numeric = store.recordFailure(failure({ trigger: 'ERR_TLS_3.45', rootCause: 'handshake rejected', action: 'inspect the certificate' }));
    verify(store, numeric.id);
    expect(store.recall({ scope: numeric.scope, prompt: 'ERR_TLS_3.45' }).map(record => record.id)).toEqual([numeric.id]);
  });

  it('honors denied failures and explicit exclusions without discarding an applicable correction', () => {
    const { store } = fixture();
    const busy = store.recordFailure(failure({ trigger: 'SQLITE_BUSY committing a transaction',
      rootCause: 'writer keeps the transaction open', action: 'close the writer before retrying' }));
    const refused = store.recordFailure(failure({ trigger: 'ECONNREFUSED connecting to the service',
      rootCause: 'endpoint port is wrong', action: 'correct the endpoint port' }));
    const permission = store.recordFailure(failure({ trigger: '权限校验失败',
      rootCause: '凭据没有项目读取权限', action: '授予项目读取权限' }));
    const missing = store.recordFailure(failure({ trigger: 'configuration file is absent', rootCause: 'file was deleted', action: 'restore the file' }));
    const cancelled = store.recordFailure(failure({ trigger: '任务取消后资源泄漏', rootCause: '取消分支跳过清理步骤', action: '取消后释放资源' }));
    const scheduled = store.recordFailure(failure({ trigger: '任务调度延迟', rootCause: '调度器暂停', action: '恢复调度器' }));
    for (const record of [busy, refused, permission, missing, cancelled, scheduled]) verify(store, record.id);
    for (const prompt of ['SQLITE_BUSY is absent; only rename a heading.', 'No SQLITE_BUSY; only rename a heading.',
      'SQLITE_BUSY is not present; only rename a heading.', 'SQLITE_BUSY is not applicable; only rename a heading.',
      'SQLITE_BUSY did not occur; only rename a heading.', '没有发生SQLITE_BUSY；只改标题。',
      '任务没有取消，也没有资源泄漏；只调整界面颜色。',
      'Exclude SQLITE_BUSY corrections.', '不要采用SQLITE_BUSY的修复。',
      'Do not retry the writer; SQLITE_BUSY committing a transaction.']) {
      expect(store.recall({ scope: busy.scope, prompt }), prompt).toEqual([]);
    }
    for (const prompt of ['ECONNREFUSED is absent; investigate SQLITE_BUSY.',
      'Exclude ECONNREFUSED corrections; fix SQLITE_BUSY.', '不要采用ECONNREFUSED的修复；请排查SQLITE_BUSY。',
      'SQLITE_BUSY is not resolved yet.']) {
      expect(store.recall({ scope: busy.scope, prompt }).map(record => record.id), prompt).toEqual([busy.id]);
    }
    expect(store.recall({ scope: permission.scope, prompt: '凭据没有读取权限，如何修复权限校验失败？' })
      .map(record => record.id)).toEqual([permission.id]);
  });

  it('uses project mentions only to narrow the supplied scope, including explicit project exclusions', () => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger: 'SQLITE_BUSY', rootCause: 'writer contention', action: 'close the writer' }));
    verify(store, record.id);
    for (const prompt of ['Fix SQLITE_BUSY in github:other/payments.', 'Fix SQLITE_BUSY in GitHub:other/payments.',
      'Fix SQLITE_BUSY in gitlab:owner/wiki.',
      'Fix SQLITE_BUSY in github:other/payments; github:owner/wiki must remain unchanged.',
      '不要修改github:owner/wiki；排查SQLITE_BUSY。',
      'Fix SQLITE_BUSY in github:owner/wiki and github:other/payments.']) {
      expect(store.recall({ scope: record.scope, prompt }), prompt).toEqual([]);
    }
    for (const prompt of ['Fix SQLITE_BUSY in github:owner/wiki.',
      'Fix SQLITE_BUSY in github:owner/wiki#42.',
      'Fix SQLITE_BUSY in github:owner/wiki; do not change github:other/payments.',
      '不要修改github:other/payments；修复github:owner/wiki中的SQLITE_BUSY。']) {
      expect(store.recall({ scope: record.scope, prompt }).map(entry => entry.id), prompt).toEqual([record.id]);
    }
    const numbered = store.recordFailure(failure({ scope: 'github:owner/wiki3.45', trigger: 'SQLITE_BUSY',
      rootCause: 'writer contention', action: 'close the writer' }));
    verify(store, numbered.id);
    expect(store.recall({ scope: numbered.scope, prompt: 'Fix SQLITE_BUSY in github:owner/wiki3.45#42.' })
      .map(entry => entry.id)).toEqual([numbered.id]);
  });

  it('requires explicit stored version bounds rather than treating query or trigger versions as validation', () => {
    const { store, file } = fixture();
    const bounded = store.recordFailure(failure({ trigger: 'SQLite 3.45 WAL checkpoint stalls',
      rootCause: 'long reader blocks checkpoint', action: 'close the long reader; validated only on SQLite 3.45' }));
    const unknown = store.recordFailure(failure({ trigger: 'SQLite 3.46 WAL checkpoint stalls',
      rootCause: 'slow checkpoint', action: 'inspect the checkpoint' }));
    const target = { project: bounded.scope, dirty: false, productVersions: { sqlite: '3.45' } };
    store.verify(bounded.id, { runId: 'qa-bounded', evidence: ['run:qa-bounded#test'] }, { target });
    verify(store, unknown.id);
    for (const [prompt, version] of [['SQLite 3.46 WAL checkpoint stalls', '3.46'], ['SQLite3.46 WAL checkpoint stalls', '3.46'],
      ['SQLite version 3.46 WAL checkpoint stalls', '3.46'], ['SQLite 3.45.1 WAL checkpoint stalls', '3.45.1'],
      ['SQLite 3.45-beta WAL checkpoint stalls', '3.45-beta'], ['SQLite 3.45+vendor WAL checkpoint stalls', '3.45+vendor'],
      ['SQLite WAL checkpoint stalls; use fixes for version 3 only.', '3'],
      ['SQLite 3.46 已升级，不采用 3.45 checkpoint 修复。', '3.46'], ['Upgrade SQLite 3.45 to 3.46; checkpoint stalls.', '3.46']]) {
      expect(store.recall({ scope: bounded.scope, prompt, target: { ...target, productVersions: { sqlite: version } } }), prompt).toEqual([]);
    }
    expect(store.recall({ scope: bounded.scope, prompt: 'SQLite 3.45 WAL checkpoint stalls', target }).map(record => record.id)).toEqual([bounded.id]);
    expect(store.recall({ scope: bounded.scope, prompt: 'SQLite WAL checkpoint' }).map(record => record.id)).toEqual([unknown.id]);
    expect(store.recall({ scope: bounded.scope, prompt: 'SQLite 3.45 WAL checkpoint stalls',
      target: { ...target, productVersions: { sqlite: '3.46' } } })).toEqual([]);
    expect(store.recall({ scope: bounded.scope, prompt: 'SQLite 3.45 WAL checkpoint stalls',
      target: { ...target, productVersions: {} } }).some(record => record.id === bounded.id)).toBe(false);
    expect(store.recall({ scope: bounded.scope, prompt: 'SQLite 3.45 WAL checkpoint stalls',
      target: { ...target, productVersions: Object.create({ sqlite: '3.45' }) } }).some(record => record.id === bounded.id)).toBe(false);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.recall({ scope: bounded.scope, prompt: 'SQLite 3.45 WAL checkpoint stalls', target }).map(record => record.id)).toEqual([bounded.id]);
    expect(reopened.recall({ scope: bounded.scope, prompt: 'SQLite 3.46 WAL checkpoint stalls',
      target: { ...target, productVersions: { sqlite: '3.46' } } })).toEqual([]);
    expect(JSON.parse(reopened.export({ scope: bounded.scope })).version).toBe(1);
  });

  it.each([
    ['SQLITE_BUSY', 'close the writer', 'SQLITE_BUSY; fix only github:other/payments and do not edit its README', false],
    ['SQLITE_BUSY', 'close the writer', 'Fix SQLITE_BUSY in github:owner/wiki and do not change github:other/payments', true],
    ['HTTP429', 'back off before retrying', 'HTTP429', true],
    ['HTTP 429', 'back off before retrying', 'HTTP 429', true],
    ['TS2322', 'correct the type annotation', 'TS2322', true],
    ['SQLITE_BUSY', 'close the writer', 'SQLITE_BUSY on Node 22.16', true],
    ['SQLite 3.45 WAL checkpoint stalls', 'close the reader; validated only on SQLite 3.45',
      'SQLite 3.45 WAL checkpoint stalls on Node 22.16', true, '3.45'],
    ['SQLite 3.45 WAL checkpoint stalls', 'close the reader; validated only on SQLite 3.45',
      'SQLite 3.45 WAL checkpoint stalls on Node (22.16)', true, '3.45'],
    ['SQLite 3.45 WAL checkpoint stalls', 'close the reader; validated only on SQLite 3.45',
      'SQLite 3.46 WAL checkpoint stalls on Node 22.16', false, '3.46'],
    ['configuration file is absent', 'restore the file', 'configuration file is absent', true],
    ['No space left on device', 'free disk space', 'No space left on device', true],
    ['ORA-00942 table or view does not exist', 'grant access to the table', 'ORA-00942 table or view does not exist', true],
    ['SQLITE_BUSY during transaction commit', 'close the writer transaction before retrying the commit',
      'SQLITE_BUSY during transaction commit; do not change transaction metrics', true],
    ['SQLITE_BUSY', 'close the writer', 'SQLITE_BUSY; do not update the writer profile picture', true],
    ['任务取消后资源泄漏', '取消后关闭句柄并释放资源', '任务取消后资源泄漏；不要修改资源列表的颜色', true],
    ['SQLITE_BUSY', 'close the writer', 'SQLITE_BUSY is not the issue; only update documentation', false],
    ['SQLITE_BUSY', 'close the writer', 'SQLITE_BUSY did not recur; only rename heading', false],
    ['任务取消后资源泄漏', '取消后关闭句柄并释放资源', '任务没有取消且没有资源泄漏；只修改任务标题', false],
  ])('checks matching boundaries for %s / %s / %s', (trigger, action, prompt, applicable, version?: string) => {
    const { store } = fixture();
    const record = store.recordFailure(failure({ trigger, action, rootCause: 'independent observed cause' }));
    const target = version ? { project: record.scope, dirty: false, productVersions: { sqlite: '3.45' } } : undefined;
    store.verify(record.id, { runId: 'run-independent-qa', evidence: ['evidence://regression-passed'] }, target ? { target } : undefined);
    const queryTarget = target && { ...target, revision: 'b'.repeat(40), productVersions: { sqlite: version! }, runtimeVersions: { node: '22.16' } };
    expect(store.recall({ scope: record.scope, prompt, target: queryTarget }).map(entry => entry.id)).toEqual(applicable ? [record.id] : []);
  });

  it('does not let a different record decide whether a failure symptom is positive', () => {
    const { store } = fixture();
    const missing = store.recordFailure(failure({ trigger: 'configuration file is absent', action: 'restore the file' }));
    verify(store, missing.id);
    const prompt = 'configuration file is absent';
    expect(store.recall({ scope: missing.scope, prompt }).map(entry => entry.id)).toEqual([missing.id]);
    const other = store.recordFailure(failure({ trigger: 'configuration file', action: 'inspect the file' }));
    verify(store, other.id);
    expect(store.recall({ scope: missing.scope, prompt }).map(entry => entry.id)).toContain(missing.id);
  });

  it('withholds an explicitly restricted legacy lesson without structured applicability', () => {
    const { store } = fixture();
    const restricted = store.recordFailure(failure({ trigger: 'SQLite 3.45 WAL checkpoint stalls',
      action: 'close the reader; validated only on SQLite 3.45' }));
    const ordinary = store.recordFailure(failure({ trigger: 'SQLITE_BUSY', action: 'close the writer' }));
    for (const record of [restricted, ordinary]) verify(store, record.id);
    for (const prompt of ['SQLite 3.45 WAL checkpoint stalls', 'SQLite 3.46 WAL checkpoint stalls',
      'SQLite 3.45 WAL checkpoint stalls on Node 22.16']) {
      expect(store.recall({ scope: restricted.scope, prompt }).map(entry => entry.id)).not.toContain(restricted.id);
    }
    expect(store.recall({ scope: ordinary.scope, prompt: 'SQLITE_BUSY on Node 22.16' }).map(entry => entry.id)).toEqual([ordinary.id]);
  });

  it('validates untrusted inputs without writes and redacts credentials before SQLite persistence', () => {
    const { store, file } = fixture();
    for (const input of [failure({ evidence: [] }), failure({ evidence: ['transcript\ncontent'] }), failure({ scope: '' }),
      failure({ action: '密'.repeat(2000) }), failure({ expiresAt: '2026-11-08T10:00:00Z' }),
      failure({ expiresAt: '2030-01-01T00:00:00Z' }), { ...failure(), transcript: 'raw conversation' },
      failure({ source: { runId: 'api_key=not-allowed', workItemId: '42' } }), failure({ action: 'bad\0value' })]) {
      expect(() => store.recordFailure(input)).toThrow();
    }
    expect(store.list({ scope: failure().scope })).toEqual([]);
    for (const input of [{ scope: failure().scope, limit: -1 }, { scope: failure().scope, limit: 101 },
      { scope: failure().scope, status: 'anything' }]) expect(() => store.list(input as never)).toThrow();
    expect(() => store.recall({ scope: failure().scope, prompt: 'sqlite', maxChars: Infinity })).toThrow();
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz1234567890';
    const record = store.recordFailure(failure({ rootCause: `token=${secret}`, action: 'use Bearer plainSecretInHeader to retry',
      evidence: ['https://user:urlPassword@local.test/report?token=querySecret'] }));
    expect(JSON.stringify(record)).not.toMatch(/abcdefghijklmnopqrstuvwxyz|plainSecretInHeader|urlPassword|querySecret/);
    const quoted = store.recordFailure(failure({ trigger: 'quoted credential', rootCause: '{"password": "jsonSecret"}',
      action: '-----BEGIN PRIVATE KEY-----\nprivateMaterial\n-----END PRIVATE KEY-----' }));
    expect(JSON.stringify(quoted)).not.toMatch(/jsonSecret|privateMaterial/);
    const signed = store.recordFailure(failure({ trigger: 'signed artifact', evidence: ['https://local.test/report?X-Amz-Signature=signedSecret&key=otherSecret'],
      action: '-----BEGIN PRIVATE KEY-----\nincompletePrivateMaterial' }));
    expect(JSON.stringify(signed)).not.toMatch(/signedSecret|otherSecret|incompletePrivateMaterial/);
    for (const filename of readdirSync(join(file, '..'))) {
      expect(readFileSync(join(file, '..', filename)).toString('utf8'))
        .not.toMatch(/abcdefghijklmnopqrstuvwxyz|plainSecretInHeader|urlPassword|querySecret|jsonSecret|privateMaterial|signedSecret|otherSecret|incompletePrivateMaterial/);
    }
    expect(() => store.verify(record.id, { evidence: [], runId: 'qa' })).toThrow();
    expect(() => store.verify('invalid-id', { evidence: ['test://passed'], runId: 'qa' })).toThrow();
    expect(() => store.revoke('00000000-0000-4000-8000-000000000000')).toThrow('not found');
    store.close();
    expect(() => store.recordFailure(failure())).toThrow('closed');
    expect(() => store.list({ scope: record.scope })).toThrow('closed');
    expect(() => new ExperienceStore({ file, now: () => new Date(NaN) })).toThrow();
  });

  it('bounds actual adoption receipt bytes and rolls back receipts, metrics and eviction together', () => {
    const { store, file } = fixture();
    const protectedRecord = store.recordFailure(failure({ trigger: 'important verified record' }));
    verify(store, protectedRecord.id);
    for (let index = 0; index < 1005; index++) store.recordFailure(failure({ trigger: `failure-${index}` }));
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    expect(database.prepare('SELECT COUNT(*) AS count FROM experiences').get()?.count).toBe(1000);
    expect(store.list({ scope: protectedRecord.scope, status: 'verified' }).map(record => record.id)).toContain(protectedRecord.id);
    for (let index = 0; index < 1000; index++) {
      clock = new Date(clock.getTime() + 1);
      store.recordFailure(failure({ trigger: `large-${index}-${'t'.repeat(990)}`, rootCause: 'r'.repeat(2048), action: 'a'.repeat(4096),
        evidence: Array.from({ length: 8 }, (_, entry) => `evidence://${entry}/${'e'.repeat(230)}`) }));
    }
    const stats = database.prepare('SELECT COUNT(*) AS count, SUM(bytes) AS bytes FROM experiences').get()!;
    expect(Number(stats.count)).toBeLessThan(1000);
    expect(Number(stats.bytes)).toBeLessThanOrEqual(8 * 1024 * 1024);
    const adoptionRecords = Array.from({ length: 5 }, (_, index) => {
      const record = store.recordFailure(failure({ trigger: `receipt-bound-${index}` }));
      return verify(store, record.id);
    });
    const beforeAdoptions = Number(database.prepare('SELECT COUNT(*) AS count FROM experiences').get()!.count);
    for (const record of adoptionRecords.slice(0, 4)) {
      for (let index = 0; index < 64; index++) store.adopt({ id: record.id, scope: record.scope,
        source: { runId: `receipt-run-${index}`, workItemId: `${record.scope}#99` } });
    }
    const accounted = database.prepare(`SELECT COALESCE(SUM(bytes), 0)
      + (SELECT COALESCE(SUM(length(CAST(experience_id AS BLOB)) + length(CAST(source_hash AS BLOB))
        + length(CAST(run_hash AS BLOB)) + length(CAST(evidence_hash AS BLOB)) + 128), 0) FROM experience_receipts)
      + (SELECT COUNT(*) * 256 FROM experience_verifications)
      + (SELECT COALESCE(SUM(length(CAST(payload AS BLOB)) + 256), 0) FROM experience_applicability) AS bytes FROM experiences`).get()!;
    expect(Number(accounted.bytes)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(Number(database.prepare('SELECT COUNT(*) AS count FROM experiences').get()!.count)).toBeLessThan(beforeAdoptions);
    const target = adoptionRecords[4];
    database.exec(`CREATE TRIGGER reject_adoption_eviction AFTER DELETE ON experiences
      BEGIN SELECT RAISE(ABORT, 'simulated adoption eviction failure'); END;`);
    let recovered = false;
    for (let index = 0; index < 64; index++) {
      const adoption = { id: target.id, scope: target.scope, source: { runId: `eviction-run-${index}`, workItemId: `${target.scope}#99` } };
      const records = database.prepare('SELECT id, bytes FROM experiences ORDER BY id').all();
      const receipts = database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all();
      const counts = store.metrics({ scope: target.scope });
      try { store.adopt(adoption); }
      catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain('simulated adoption eviction failure');
        expect(database.prepare('SELECT id, bytes FROM experiences ORDER BY id').all()).toEqual(records);
        expect(database.prepare('SELECT * FROM experience_receipts ORDER BY experience_id, source_hash').all()).toEqual(receipts);
        expect(store.metrics({ scope: target.scope })).toEqual(counts);
        database.exec('DROP TRIGGER reject_adoption_eviction');
        const retried = store.adopt(adoption);
        expect(retried.adoptions).toBe(counts.adoptions + 1);
        expect(store.adopt(adoption)).toEqual(retried);
        expect(Number(database.prepare('SELECT COUNT(*) AS count FROM experiences').get()!.count)).toBeLessThan(records.length);
        recovered = true;
        break;
      }
    }
    expect(recovered).toBe(true);
    clock = new Date(clock.getTime() + 1);
    const row = store.recordFailure(failure());
    for (let index = 0; index < 12; index++) store.recordFailure(failure({ source: { runId: `failure-${index}`, workItemId: '42' }, evidence: [`evidence://${index}`] }));
    const bounded = store.list({ scope: row.scope, limit: 100 }).find(record => record.id === row.id)!;
    expect(bounded.observations).toHaveLength(8);
    expect(bounded.evidence).toHaveLength(8);
    expect(bounded.occurrences).toBe(13);
    expect(statSync(file).size).toBeLessThanOrEqual(32 * 1024 * 1024);
  });

  it('serializes concurrent processes without duplicate fingerprints or lost occurrence updates', async () => {
    const { store, file } = fixture();
    const moduleUrl = new URL('./experience-store.ts', import.meta.url).href;
    const input = failure();
    const ready: Promise<void>[] = [];
    const finished: Promise<void>[] = [];
    const workers: ChildProcess[] = [];
    for (let worker = 0; worker < 4; worker++) {
      const script = `import { ExperienceStore } from ${JSON.stringify(moduleUrl)};
        const store = new ExperienceStore({file:${JSON.stringify(file)},now:()=>new Date('2026-11-08T10:00:00Z')});
        process.send('ready');
        process.once('message',()=>{for(let index=0;index<12;index++){const failure={...${JSON.stringify(input)},source:{runId:'worker-${worker}-'+index,workItemId:'42'},evidence:['evidence://worker-${worker}-'+index]};store.recordFailure(failure);store.recordFailure(failure);}store.close();process.disconnect();});`;
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      children.push(child);
      workers.push(child);
      let stderr = '';
      child.stderr!.on('data', chunk => { stderr += chunk.toString(); });
      ready.push(new Promise((resolve, reject) => {
        child.once('message', () => resolve());
        child.once('error', reject);
        child.once('exit', code => { if (code !== 0) reject(new Error(stderr)); });
      }));
      finished.push(new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(stderr)));
      }));
    }
    const completion = Promise.all(finished);
    await Promise.race([Promise.all(ready), completion]);
    for (const child of workers) child.send('go');
    await completion;
    const records = store.list({ scope: input.scope });
    expect(records).toHaveLength(1);
    expect(records[0].occurrences).toBe(48);
    expect(records[0].observations).toHaveLength(8);
  });

  it('retains failure guards and demotes saturated records without growing their receipt history', () => {
    const { store, file } = fixture();
    const first = store.recordFailure(failure());
    for (let index = 1; index < 256; index++) store.recordFailure(failure({
      source: { runId: `bounded-run-${index}`, workItemId: '42' }, evidence: [`evidence://bounded-${index}`],
    }));
    const before = store.list({ scope: first.scope })[0];
    expect(before.occurrences).toBe(256);
    expect(before.observations.some(entry => entry.source.runId === first.source.runId)).toBe(false);
    expect(store.recordFailure(failure())).toEqual(before);
    expect(() => store.verify(first.id, { runId: 'bounded-run-1', evidence: ['evidence://new-proof'] })).toThrow('independent run');
    expect(() => store.verify(first.id, { runId: 'qa', evidence: first.evidence })).toThrow('new evidence');
    expect(verify(store, first.id).status).toBe('verified');
    const overflow = failure({ source: { runId: 'overflow', workItemId: '42' }, evidence: ['evidence://overflow'] });
    const demoted = store.recordFailure(overflow);
    expect(demoted.status).toBe('candidate');
    expect(demoted.verifiedEvidence).toBeUndefined();
    expect(demoted.occurrences).toBe(257);
    expect(store.recordFailure(overflow)).toEqual(demoted);
    expect(store.recordFailure({ ...overflow, evidence: [...overflow.evidence, 'evidence://overflow-detail'] }).occurrences).toBe(257);
    for (let index = 0; index < 20; index++) store.recordFailure(failure({
      source: { runId: `overflow-${index}`, workItemId: '42' }, evidence: [`evidence://overflow-${index}`],
    }));
    expect(store.recall({ scope: first.scope, prompt: 'sqlite' })).toEqual([]);
    expect(store.get(first.id, first.scope)?.observations).toHaveLength(8);
    expect(store.get(first.id, first.scope)?.evidence).toHaveLength(8);
    expect(() => store.verify(first.id, { runId: 'fresh-qa', evidence: ['evidence://fresh-proof'] })).toThrow('saturated');
    expect(JSON.parse(store.export({ scope: first.scope })).experiences).toEqual([]);
    const database = openSqlite({ file, schema: '', version: 3 });
    databases.push(database);
    expect(database.prepare("SELECT COUNT(*) AS count FROM experience_receipts WHERE source_hash NOT LIKE 'metric:%'").get()?.count).toBe(256);
    expect(database.prepare("SELECT COUNT(*) AS count FROM experience_receipts WHERE source_hash LIKE 'metric:%'").get()?.count).toBe(1);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.get(first.id, first.scope)?.status).toBe('candidate');
    expect(() => reopened.verify(first.id, { runId: 'overflow-1', evidence: ['evidence://unrelated-proof'] })).toThrow('saturated');
  });
});
