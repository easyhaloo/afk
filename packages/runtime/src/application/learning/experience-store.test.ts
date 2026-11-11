import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperienceStore, experienceContextMatches, type RecordFailureInput } from './experience-store.js';
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

  it('bounds retained records, payload bytes, recent evidence provenance, and physical SQLite growth', () => {
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
