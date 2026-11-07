import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperienceStore, type RecordFailureInput } from './experience-store.js';
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
    const database = openSqlite({ file, schema: '', version: 2 });
    databases.push(database);
    database.exec('DROP TABLE experience_verifications; PRAGMA user_version = 1;');
    const migrated = fixture(file).store;
    expect(migrated.verify(candidate.id, proof)).toEqual(verified);
    migrated.recordFailure(failure({ source: { runId: 'after-migration', workItemId: '42' }, evidence: ['evidence://after-migration'] }));
    expect(() => migrated.verify(candidate.id, proof)).toThrow('fresh');
    expect(database.prepare('PRAGMA user_version').get()?.user_version).toBe(2);
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
    const database = openSqlite({ file, schema: '', version: 2 });
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
    const database = openSqlite({ file, schema: '', version: 2 });
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
    const database = openSqlite({ file, schema: '', version: 2 });
    databases.push(database);
    expect(database.prepare('SELECT COUNT(*) AS count FROM experience_receipts').get()?.count).toBe(256);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.get(first.id, first.scope)?.status).toBe('candidate');
    expect(() => reopened.verify(first.id, { runId: 'overflow-1', evidence: ['evidence://unrelated-proof'] })).toThrow('saturated');
  });
});
