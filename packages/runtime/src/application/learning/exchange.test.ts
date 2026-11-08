import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperienceStore, type ExperienceExchange, type RecordFailureInput } from './experience-store.js';

const scope = 'github:acme/source';
const target = 'github:acme/target';
const now = new Date('2026-11-08T10:00:00.000Z');
const directories: string[] = [];
const stores: ExperienceStore[] = [];
function fixture(file?: string) {
  const root = mkdtempSync(join(tmpdir(), 'experience-exchange-'));
  directories.push(root);
  file ??= join(root, 'experience.sqlite');
  const store = new ExperienceStore({ file, now: () => now });
  stores.push(store);
  return { store, file };
}
function failure(overrides: Partial<RecordFailureInput> = {}): RecordFailureInput {
  return { scope, trigger: 'sqlite locked', rootCause: 'parallel writes', action: 'use immediate transactions',
    evidence: ['run:source-failure#qa.failed'], source: { runId: 'source-failure', workItemId: `${scope}#1` }, ...overrides };
}
function verified(store: ExperienceStore) {
  return store.verify(store.recordFailure(failure()).id, { runId: 'source-qa', evidence: ['run:source-qa#qa.passed'] });
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('portable learning exchange', () => {
  it('keeps original failure identity immutable and cannot use it to shadow local governance', () => {
    const source = fixture().store;
    const original = failure();
    const record = source.recordFailure(original);
    source.verify(record.id, { runId: 'source-qa', evidence: ['run:source-qa#qa.passed'], rootCause: 'corrected cause', action: 'corrected action' });
    const document = JSON.parse(source.export({ scope })) as ExperienceExchange;
    expect(document.experiences[0].failureIdentity).toEqual({ trigger: original.trigger, rootCause: original.rootCause, action: original.action });
    const store = fixture().store;
    const [candidate] = store.import({ scope: target, json: JSON.stringify(document) });
    const changed = structuredClone(document);
    changed.experiences[0].failureIdentity!.rootCause = 'forged baseline';
    expect(() => store.import({ scope: target, json: JSON.stringify(changed) })).toThrow('origin conflicts');
    expect(store.get(candidate.id, target)?.failureIdentity).toEqual(document.experiences[0].failureIdentity);
    delete changed.experiences[0].failureIdentity;
    expect(() => store.import({ scope: target, json: JSON.stringify(changed) })).toThrow('original failure identity');
    const governed = fixture().store;
    const local = governed.recordFailure({ ...original, scope: target, source: { runId: 'local-source', workItemId: `${target}#2` } });
    governed.revoke(local.id);
    expect(() => governed.import({ scope: target, json: JSON.stringify(document) })).toThrow('local governance');
    expect(governed.list({ scope: target })).toHaveLength(1);
    expect(governed.get(local.id, target)?.status).toBe('revoked');
  });

  it('withdraws copied corrected advice when the original diagnosis and Inspect action recur in the target', () => {
    const store = fixture().store;
    const original = failure({ rootCause: 'upstream request failed', action: 'Inspect the sqlite evidence and validate a correction before retrying.' });
    const record = store.recordFailure(original);
    store.verify(record.id, { runId: 'source-qa', evidence: ['run:source-qa#qa.passed'],
      rootCause: 'parallel writer serialization missing', action: 'Use BEGIN IMMEDIATE and bounded retry' });
    const copied = store.copy({ id: record.id, scope, targetScope: target });
    store.verify(copied.id, { runId: 'target-qa', evidence: ['run:target-qa#qa.passed'] });
    const recurring = store.recordFailure({ ...original, scope: target, source: { runId: 'target-failure', workItemId: `${target}#2` }, evidence: ['run:target-failure#qa.failed'] });
    expect(recurring).toMatchObject({ id: copied.id, status: 'candidate' });
    expect(store.list({ scope: target })).toHaveLength(1);
    expect(store.recall({ scope: target, prompt: 'sqlite' })).toEqual([]);
    expect(store.metrics({ scope: target }).recurrences).toBe(1);
  });

  it('exports no verification authority and imports only deduplicated candidates across machines', () => {
    const source = fixture().store;
    const record = verified(source);
    const json = source.export({ scope });
    expect(json).not.toContain('verifiedEvidence');
    expect(json).not.toContain('source-qa');
    const { store, file } = fixture();
    const [imported] = store.import({ scope: target, json });
    expect(imported).toMatchObject({ scope: target, status: 'candidate', origin: { id: record.id, scope, source: record.source } });
    expect(imported.verifiedEvidence).toBeUndefined();
    expect(store.import({ scope: target, json })).toEqual([imported]);
    expect(store.recall({ scope: target, prompt: 'sqlite' })).toEqual([]);
    expect(store.recall({ scope, prompt: 'sqlite' })).toEqual([]);
    store.close();
    const reopened = fixture(file).store;
    expect(reopened.import({ scope: target, json })).toEqual([imported]);
    expect(() => reopened.verify(imported.id, { runId: record.source.runId, evidence: ['new'] })).toThrow('independent');
    reopened.verify(imported.id, { runId: 'target-qa', evidence: ['run:target-qa#qa.passed'] });
    expect(reopened.recall({ scope: target, prompt: 'sqlite' }).map(entry => entry.id)).toEqual([imported.id]);
    expect(() => reopened.import({ scope: target, json })).toThrow('local governance');
    reopened.revoke(imported.id);
    expect(() => reopened.import({ scope: target, json })).toThrow('local governance');
    expect(reopened.get(imported.id, target)?.status).toBe('revoked');
    expect(reopened.export({ scope: target })).toContain('"experiences":[]');
  });

  it('copies only explicitly selected live verified sources and preserves the origin on re-export', () => {
    const store = fixture().store;
    const record = store.recordFailure(failure());
    expect(() => store.copy({ id: record.id, scope, targetScope: target })).toThrow('live verified');
    verified(store);
    expect(() => store.copy({ id: record.id, scope, targetScope: scope })).toThrow('different target');
    expect(() => store.copy({ id: record.id, scope: target, targetScope: scope })).toThrow('live verified');
    const copied = store.copy({ id: record.id, scope, targetScope: target });
    expect(copied.status).toBe('candidate');
    expect(store.copy({ id: record.id, scope, targetScope: target })).toEqual(copied);
    const machine = fixture().store;
    expect(machine.import({ scope: target, json: store.export({ scope: target }) })[0].origin).toEqual(copied.origin);
    store.verify(copied.id, { runId: 'local-target-qa', evidence: ['run:local-target-qa#qa.passed'] });
    const recurring = store.recordFailure(failure({ scope: target, source: { runId: 'target-failed', workItemId: `${target}#2` }, evidence: ['run:target-failed#qa.failed'] }));
    expect(recurring).toMatchObject({ id: copied.id, status: 'candidate' });
    expect(store.metrics({ scope: target }).recurrences).toBe(1);
    store.revoke(record.id);
    expect(() => store.copy({ id: record.id, scope, targetScope: target })).toThrow('live verified');
  });

  it.each(['status', 'verifiedEvidence', 'observations', 'provenanceSaturated'])('rejects untrusted authority fields: %s', field => {
    const store = fixture().store;
    verified(store);
    const document = JSON.parse(store.export({ scope }));
    document.experiences[0][field] = field === 'status' ? 'verified' : {};
    expect(() => store.import({ scope: target, json: JSON.stringify(document) })).toThrow();
    expect(store.list({ scope: target })).toEqual([]);
  });

  it('validates bytes, entry counts, canonical provenance, expiry, and conflicts before committing a batch', () => {
    const source = fixture().store;
    verified(source);
    const document = JSON.parse(source.export({ scope })) as ExperienceExchange;
    const store = fixture().store;
    const attempt = (value: unknown) => store.import({ scope: target, json: JSON.stringify(value) });
    expect(() => store.import({ scope: target, json: 'x'.repeat(1024 * 1024 + 1) })).toThrow();
    expect(() => store.import({ scope: target, json: '界'.repeat(400000) })).toThrow('byte limit');
    expect(() => store.import({ scope: target, json: '{' })).toThrow();
    expect(() => attempt({ ...document, version: 2 })).toThrow();
    expect(() => attempt({ ...document, experiences: Array(101).fill(document.experiences[0]) })).toThrow();
    for (const mutation of [
      (entry: ExperienceExchange['experiences'][number]) => { entry.origin.scope = 'wrong'; },
      (entry: ExperienceExchange['experiences'][number]) => { entry.origin.source.workItemId = `${target}#1`; },
      (entry: ExperienceExchange['experiences'][number]) => { entry.expiresAt = now.toISOString(); },
      (entry: ExperienceExchange['experiences'][number]) => { entry.expiresAt = '2030-01-01T00:00:00.000Z'; },
      (entry: ExperienceExchange['experiences'][number]) => { entry.action = 'x'.repeat(4097); },
    ]) {
      const invalid = structuredClone(document);
      mutation(invalid.experiences[0]);
      expect(() => attempt(invalid)).toThrow();
      expect(store.list({ scope: target })).toEqual([]);
    }
    const [imported] = attempt(document);
    store.verify(imported.id, { runId: 'local-qa', evidence: ['run:local-qa#qa.passed'] });
    const fresh = structuredClone(document.experiences[0]);
    fresh.origin.id = 'a0160cdc-8fc1-4116-99eb-5457e3bd34ce';
    expect(() => attempt({ ...document, experiences: [fresh, document.experiences[0]] })).toThrow('local governance');
    expect(store.list({ scope: target })).toHaveLength(1);
    expect(() => store.export({ scope, limit: 101 })).toThrow();
    expect(() => store.import({ scope: 'wrong', json: JSON.stringify(document) })).toThrow();
  });

  it('rejects changed origin claims and content while retaining the original candidate', () => {
    const source = fixture().store;
    verified(source);
    const document = JSON.parse(source.export({ scope })) as ExperienceExchange;
    const store = fixture().store;
    const [candidate] = store.import({ scope: target, json: JSON.stringify(document) });
    for (const mutate of [
      (entry: ExperienceExchange['experiences'][number]) => { entry.action = 'unrelated action'; },
      (entry: ExperienceExchange['experiences'][number]) => { entry.origin.source.runId = 'forged-provenance'; },
    ]) {
      const changed = structuredClone(document);
      mutate(changed.experiences[0]);
      expect(() => store.import({ scope: target, json: JSON.stringify(changed) })).toThrow(/origin conflicts|source receipts/);
      expect(store.list({ scope: target })).toEqual([candidate]);
    }
    store.close();
    expect(() => store.export({ scope: target })).toThrow('closed');
    expect(() => store.import({ scope: target, json: JSON.stringify(document) })).toThrow('closed');
    expect(() => store.metrics({ scope: target })).toThrow('closed');
  });

  it('preserves source-run exclusions beyond the observation window without importing verification history', () => {
    const source = fixture().store;
    const record = source.recordFailure(failure());
    for (let index = 0; index < 12; index++) source.recordFailure(failure({ source: { runId: `failure-${index}`, workItemId: `${scope}#2` }, evidence: [`run:failure-${index}#qa.failed`] }));
    source.verify(record.id, { runId: 'independent-source-qa', evidence: ['run:independent-source-qa#qa.passed'] });
    const json = source.export({ scope });
    const document = JSON.parse(json) as ExperienceExchange;
    expect(document.experiences[0].receipts).toHaveLength(13);
    expect(json).not.toContain('independent-source-qa');
    const store = fixture().store;
    const [imported] = store.import({ scope: target, json });
    expect(() => store.verify(imported.id, { runId: 'failure-0', evidence: ['new-local-proof'] })).toThrow('independent run');
    expect(() => store.verify(imported.id, { runId: 'new-local-qa', evidence: ['run:failure-0#qa.failed'] })).toThrow('new evidence');
    expect(store.verify(imported.id, { runId: 'new-local-qa', evidence: ['new-local-proof'] }).status).toBe('verified');
  });
});

describe('bounded learning metrics', () => {
  it('persists separate retrieval, explicit adoption, and deduplicated recurrence counts', () => {
    const { store, file } = fixture();
    const record = verified(store);
    const adoption = { id: record.id, scope, source: { runId: 'used-run', workItemId: `${scope}#2` } };
    expect(store.metrics({ scope })).toEqual({ retrievals: 0, adoptions: 0, recurrences: 0 });
    store.recall({ scope, prompt: 'unrelated' });
    store.recall({ scope, prompt: 'sqlite', limit: 0 });
    store.recall({ scope: target, prompt: 'sqlite' });
    store.recall({ scope, prompt: 'sqlite' });
    expect(store.metrics({ scope })).toEqual({ retrievals: 1, adoptions: 0, recurrences: 0 });
    expect(store.adopt(adoption)).toEqual({ retrievals: 1, adoptions: 1, recurrences: 0 });
    store.adopt(adoption);
    expect(() => store.adopt({ ...adoption, scope: target })).toThrow();
    const recurring = failure({ source: { runId: 'recurring-run', workItemId: `${scope}#3` }, evidence: ['run:recurring-run#qa.failed'] });
    store.recordFailure(recurring);
    store.recordFailure(recurring);
    expect(() => store.adopt({ ...adoption, source: { ...adoption.source, runId: 'new' } })).toThrow('live verified');
    expect(store.metrics({ scope })).toEqual({ retrievals: 1, adoptions: 1, recurrences: 1 });
    store.close();
    expect(fixture(file).store.metrics({ scope })).toEqual({ retrievals: 1, adoptions: 1, recurrences: 1 });
  });

  it('caps adoption receipts without contaminating provenance or independent verification', () => {
    const store = fixture().store;
    const record = verified(store);
    for (let index = 0; index < 64; index++) store.adopt({ id: record.id, scope, source: { runId: `used-${index}`, workItemId: `${scope}#2` } });
    expect(() => store.adopt({ id: record.id, scope, source: { runId: 'overflow', workItemId: `${scope}#2` } })).toThrow('limit');
    expect(store.adopt({ id: record.id, scope, source: { runId: 'used-0', workItemId: `${scope}#2` } }).adoptions).toBe(64);
    expect(store.verify(record.id, { runId: 'used-0', evidence: ['run:used-0#qa.passed'] }).status).toBe('verified');
    expect(store.metrics({ scope }).adoptions).toBe(64);
    expect(store.metrics({ scope: target })).toEqual({ retrievals: 0, adoptions: 0, recurrences: 0 });
  });
});
