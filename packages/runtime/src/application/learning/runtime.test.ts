import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ObservationContext, RunEventData } from '@afk/core';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { createFailureDiagnostic } from '../workflows/failure-diagnostic.js';
import { ExperienceStore } from './experience-store.js';
import { ExperienceContextProvider, experienceScope, experienceStorePath, prepareExperienceContext, recordExecutionExperience, recordSuccessfulExperience, verifyAdoptionRun, verifyExperienceRun } from './runtime.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), 'experience-runtime-'));
  roots.push(root);
  const file = experienceStorePath(root);
  const store = new ExperienceStore({ file });
  return { root, file, store };
}

const failure = (workItemId = 'github:acme/wiki#42') => ({
  scope: experienceScope(workItemId), trigger: 'sqlite retry', rootCause: 'sqlite concurrent writer lock',
  action: 'use BEGIN IMMEDIATE and bounded retries', evidence: ['run:failed#failure.classified'],
  source: { runId: 'failed', workItemId },
});

async function recordRun(root: string, runId: string, kinds: readonly RunEventData[], workItemId = 'github:acme/wiki#42') {
  const context: ObservationContext = { traceId: runId, runId, workItemId, profileId: 'local', attempt: 1, actor: { kind: 'system', id: 'test' } };
  await new JsonlEventStore({ root }).append(kinds.map((data, index) => ({
    id: `${runId}-${index}`, schemaVersion: 1, type: data.kind, occurredAt: new Date().toISOString(), context, correlationId: runId, data,
  })));
}

describe('runtime experience loop', () => {
  it('links a successful route to bounded redacted published-change and implementation/QA commit evidence', async () => {
    const { root, file, store } = await fixture();
    const implementationCommit = 'a'.repeat(40);
    const qaCommit = 'b'.repeat(64);
    await recordRun(root, 'artifacts', [{ kind: 'workflow.recorded', name: 'sqlite implementation', version: 1, steps: [] },
      { kind: 'commit.recorded', phase: 'implementation', commitSha: implementationCommit, branch: 'feature' },
      { kind: 'qa.started' }, { kind: 'commit.recorded', phase: 'qa', commitSha: qaCommit, branch: 'feature' }, { kind: 'qa.passed' },
      { kind: 'change.published', changeId: '5', url: 'https://example.test/pull/5?token=synthetic-secret' },
      { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'awaiting human review' }]);
    const record = await recordSuccessfulExperience({ root, file, runId: 'artifacts', workItemId: 'github:acme/wiki#42' });
    expect(record.evidence).toContain(`run:artifacts#commit.recorded:implementation:${implementationCommit}`);
    expect(record.evidence).toContain(`run:artifacts#commit.recorded:qa:${qaCommit}`);
    expect(record.evidence.some(ref => ref.startsWith('https://example.test/pull/5'))).toBe(true);
    expect(record.action).toContain(implementationCommit);
    expect(record.action).toContain(qaCommit);
    expect(record.action).toContain('https://example.test/pull/5');
    expect(record.rootCause).toContain('Evidence-linked workflow route');
    expect(JSON.stringify(record)).not.toContain('synthetic-secret');
    expect(record.evidence.length).toBeLessThanOrEqual(8);
    expect(record.evidence.every(ref => Buffer.byteLength(ref) <= 256)).toBe(true);
    expect(Buffer.byteLength(record.action)).toBeLessThanOrEqual(4096);
    expect((await recordSuccessfulExperience({ root, file, runId: 'artifacts', workItemId: 'github:acme/wiki#42' })).id).toBe(record.id);
    store.close();
  });

  it.each(['javascript:UNSAFE_SENTINEL', 'https://user:UNSAFE_SENTINEL@example.test/pr/5',
    `https://example.test/${'UNSAFE_SENTINEL'.repeat(50)}`, 'https://example.test/UNSAFE_SENTINEL\n'])('omits unsafe or oversized artifact references: %s', async url => {
    const { root, file, store } = await fixture();
    await recordRun(root, 'unsafe', [{ kind: 'commit.recorded', phase: 'implementation', commitSha: 'UNSAFE_SENTINEL', branch: 'feature' },
      { kind: 'qa.started' }, { kind: 'commit.recorded', phase: 'qa', commitSha: '1'.repeat(40), branch: 'feature' },
      { kind: 'qa.failed' }, { kind: 'qa.started' }, { kind: 'qa.passed' },
      { kind: 'change.published', changeId: '5', url }, { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'review' }]);
    const record = await recordSuccessfulExperience({ root, file, runId: 'unsafe', workItemId: 'github:acme/wiki#42' });
    expect(JSON.stringify(record)).not.toContain('UNSAFE_SENTINEL');
    expect(JSON.stringify(record)).not.toContain('1'.repeat(40));
    expect(record.evidence).toEqual(['run:unsafe#qa.passed', 'run:unsafe#human_gate.opened']);
    store.close();
  });

  it('requires an intact existing audit for the exact adoption task without inferring observed use', async () => {
    const { root, store } = await fixture();
    const record = store.recordFailure(failure());
    store.verify(record.id, { runId: 'qa-proof', evidence: ['run:qa-proof#qa.passed'] });
    const workItemId = record.source.workItemId;
    const acknowledge = async (runId: string) => {
      await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId });
      return store.adopt({ id: record.id, scope: record.scope, source: { runId, workItemId } });
    };
    await expect(acknowledge('missing')).rejects.toThrow('intact recorded run');
    await recordRun(root, 'other-task', [{ kind: 'run.started' }], 'github:acme/wiki#43');
    await expect(acknowledge('other-task')).rejects.toThrow('exact work item');
    await recordRun(root, 'foreign', [{ kind: 'run.started' }], 'github:other/wiki#42');
    await expect(acknowledge('foreign')).rejects.toThrow('exact work item');
    await recordRun(root, 'corrupt', [{ kind: 'run.started' }]);
    await fs.appendFile(join(root, `${Buffer.from('corrupt').toString('base64url')}.jsonl`), 'broken\n');
    await expect(acknowledge('corrupt')).rejects.toThrow('intact recorded run');
    await expect(verifyAdoptionRun({ root, scope: 'github:other/wiki', runId: 'missing', workItemId })).rejects.toThrow('does not belong to scope');
    await expect(acknowledge(' x ')).rejects.toThrow();
    expect(store.metrics({ scope: record.scope })).toEqual({ retrievals: 0, adoptions: 0, recurrences: 0 });
    await recordRun(root, 'active', [{ kind: 'run.started' }]);
    await verifyAdoptionRun({ root, scope: record.scope, runId: 'active', workItemId });
    expect(store.metrics({ scope: record.scope }).adoptions).toBe(0);
    expect(await acknowledge('active')).toEqual({ retrievals: 0, adoptions: 1, recurrences: 0 });
    expect(await acknowledge('active')).toEqual({ retrievals: 0, adoptions: 1, recurrences: 0 });
    store.close();
  });

  it('refuses same-project re-import of a revoked local origin after a real audited verification', async () => {
    const { root, store } = await fixture();
    const record = store.recordFailure(failure());
    await recordRun(root, 'old-qa', [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
    const evidence = await verifyExperienceRun({ root, scope: record.scope, runId: 'old-qa', evidence: ['run:old-qa#regression'] });
    const proof = { runId: 'old-qa', evidence, action: 'validated sqlite correction' };
    store.verify(record.id, proof);
    const json = store.export({ scope: record.scope });
    store.revoke(record.id);
    expect(() => store.import({ scope: record.scope, json })).toThrow('local governance');
    const renamed = JSON.parse(json);
    renamed.experiences[0].origin.id = 'd451813d-cbfa-41dc-9683-2ff4c02fac8c';
    expect(() => store.import({ scope: record.scope, json: JSON.stringify(renamed) })).toThrow('local governance');
    expect(() => store.verify(record.id, proof)).toThrow('Revoked');
    expect(store.list({ scope: record.scope })).toHaveLength(1);
    expect(store.recall({ scope: record.scope, prompt: 'sqlite' })).toEqual([]);
    store.close();
  });

  it('preserves old verification exclusions when an exported local origin has recurred', async () => {
    const { root, store } = await fixture();
    const record = store.recordFailure(failure());
    await recordRun(root, 'old-qa', [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
    const evidence = await verifyExperienceRun({ root, scope: record.scope, runId: 'old-qa', evidence: ['run:old-qa#regression'] });
    const proof = { runId: 'old-qa', evidence };
    store.verify(record.id, proof);
    const json = store.export({ scope: record.scope });
    store.recordFailure({ ...failure(), source: { runId: 'recurrence', workItemId: record.source.workItemId }, evidence: ['run:recurrence#qa.failed'] });
    expect(() => store.import({ scope: record.scope, json })).toThrow('local governance');
    expect(() => store.verify(record.id, proof)).toThrow('fresh');
    expect(store.get(record.id, record.scope)?.status).toBe('candidate');
    expect(store.list({ scope: record.scope })).toHaveLength(1);
    store.close();
  });

  it('captures a success lesson only from intact real QA evidence for the exact task', async () => {
    const { root, file, store } = await fixture();
    const events = join(root, 'events');
    const input = { root: events, file, runId: 'success', workItemId: 'github:acme/wiki#42' };
    await expect(recordSuccessfulExperience(input)).rejects.toThrow('intact recorded run');
    await recordRun(events, 'success', [{ kind: 'workflow.recorded', name: 'sqlite token=synthetic-secret', version: 1, steps: [] },
      { kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
    await expect(recordSuccessfulExperience({ ...input, workItemId: 'github:acme/wiki#43' })).rejects.toThrow('another work item');
    await expect(recordSuccessfulExperience({ ...input, workItemId: 'github:other/wiki#42' })).rejects.toThrow('another project');
    expect(store.list({ scope: 'github:acme/wiki' })).toEqual([]);
    const record = await recordSuccessfulExperience(input);
    expect(record).toMatchObject({ kind: 'success', status: 'verified', source: { runId: 'success', workItemId: input.workItemId },
      evidence: ['run:success#qa.passed', 'run:success#run.finished', 'run:success#workflow.recorded'], verifiedEvidence: { runId: 'success' } });
    expect(JSON.stringify(record)).not.toContain('synthetic-secret');
    expect(record.rootCause).toContain('qa.started, qa.passed');
    expect(await recordSuccessfulExperience(input)).toEqual(record);
    expect(store.recall({ scope: record.scope, prompt: 'sqlite' }).map(entry => entry.id)).toEqual([record.id]);
    store.revoke(record.id);
    expect((await recordSuccessfulExperience(input)).status).toBe('revoked');
    expect(store.recall({ scope: record.scope, prompt: 'sqlite' })).toEqual([]);
    store.close();
  });

  it('retains bounded success provenance and rejects caller-supplied claims', async () => {
    const { root, file, store } = await fixture();
    const input = { root, file, runId: 'success-1', workItemId: 'github:acme/wiki#42' };
    await expect(recordSuccessfulExperience({ ...input, action: 'unproven claim' } as typeof input)).rejects.toThrow();
    await expect(recordSuccessfulExperience({ ...input, runId: 'x'.repeat(513) })).rejects.toThrow();
    for (let index = 1; index <= 10; index++) {
      const runId = `success-${index}`;
      await recordRun(root, runId, [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
      await recordSuccessfulExperience({ ...input, runId });
    }
    const [record] = store.list({ scope: 'github:acme/wiki' });
    expect(record.occurrences).toBe(10);
    expect(record.observations).toHaveLength(8);
    expect(record.verifiedEvidence?.runId).toBe('success-10');
    expect((await recordSuccessfulExperience(input)).occurrences).toBe(10);
    store.revoke(record.id);
    await recordRun(root, 'success-11', [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
    expect((await recordSuccessfulExperience({ ...input, runId: 'success-11' })).status).toBe('revoked');
    store.close();
  });

  it('rejects unstarted, failed, unfinished, and corrupt success claims without writing a lesson', async () => {
    const { root, file, store } = await fixture();
    for (const [runId, kinds] of [
      ['no-qa', [{ kind: 'run.finished', outcome: 'succeeded' }]],
      ['no-start', [{ kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]],
      ['failed', [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'failed' }]],
      ['unfinished', [{ kind: 'qa.started' }, { kind: 'qa.passed' }]],
      ['corrupt', [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]],
    ] as const) {
      await recordRun(root, runId, kinds);
      if (runId === 'corrupt') await fs.appendFile(join(root, `${Buffer.from(runId).toString('base64url')}.jsonl`), 'broken\n');
      await expect(recordSuccessfulExperience({ root, file, runId, workItemId: 'github:acme/wiki#42' })).rejects.toThrow();
    }
    expect(store.list({ scope: 'github:acme/wiki' })).toEqual([]);
    store.close();
  });

  it('accepts successful publication with its matching human gate without requiring a fabricated finished event', async () => {
    const { root, file, store } = await fixture();
    await recordRun(root, 'published', [{ kind: 'qa.started' }, { kind: 'qa.passed' },
      { kind: 'change.published', changeId: '5', url: 'https://example.test/pr/5' },
      { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'awaiting human merge' }]);
    const record = await recordSuccessfulExperience({ root, file, runId: 'published', workItemId: 'github:acme/wiki#42' });
    expect(record.status).toBe('verified');
    await new JsonlEventStore({ root }).append([{ id: 'published-finished', schemaVersion: 1, type: 'run.finished',
      occurredAt: new Date().toISOString(), correlationId: 'published', data: { kind: 'run.finished', outcome: 'succeeded' },
      context: { traceId: 'published', runId: 'published', workItemId: 'github:acme/wiki#42', profileId: 'local', attempt: 1, actor: { kind: 'system', id: 'test' } } }]);
    expect(await recordSuccessfulExperience({ root, file, runId: 'published', workItemId: 'github:acme/wiki#42' })).toEqual(record);
    const target = store.import({ scope: 'github:acme/other', json: store.export({ scope: record.scope }) })[0];
    expect(target).toMatchObject({ kind: 'success', status: 'candidate' });
    expect(target.verifiedEvidence).toBeUndefined();
    store.close();
  });

  it('supplies only verified relevant project experience and removes stale context after revocation', async () => {
    const { root, file, store } = await fixture();
    const plugins = new PluginRuntime();
    const provider = new ExperienceContextProvider(file);
    await plugins.activate({ manifest: { id: provider.id, version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true }, activate(context) { context.registerContextProvider(provider.id, provider); } });
    try {
      const candidate = store.recordFailure(failure());
      store.recordFailure(failure('github:foreign/wiki#42'));
      const request = { plugins, workItemId: 'github:acme/wiki#99', worktreePath: root, prompt: 'sqlite retry' };
      expect(await prepareExperienceContext(request)).toBeUndefined();
      await recordRun(join(root, 'events'), 'qa-1', [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
      const evidence = await verifyExperienceRun({ root: join(root, 'events'), scope: candidate.scope, runId: 'qa-1', evidence: ['run:qa-1#regression-test'] });
      store.verify(candidate.id, { runId: 'qa-1', evidence });
      const path = await prepareExperienceContext(request);
      expect(path).toBe('.afk/experience-context.md');
      const context = await fs.readFile(join(root, path!), 'utf8');
      expect(context).toContain('BEGIN IMMEDIATE');
      expect(context).toContain(candidate.id);
      expect(context).toContain('run:qa-1');
      expect(await prepareExperienceContext({ ...request, workItemId: 'github:unrelated/api#99' })).toBeUndefined();
      await expect(fs.readFile(join(root, path!), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await prepareExperienceContext(request);
      store.revoke(candidate.id);
      expect(await prepareExperienceContext(request)).toBeUndefined();
      await expect(fs.readFile(join(root, path!), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      await plugins.dispose('context.experience');
      expect(await prepareExperienceContext(request)).toBeUndefined();
    } finally { store.close(); await plugins.dispose(); }
  });

  it('requires intact same-project QA evidence and rejects missing, failed or corrupt runs', async () => {
    const { root, store } = await fixture();
    store.close();
    const verify = (runId: string) => verifyExperienceRun({ root, runId, scope: 'github:acme/wiki', evidence: ['evidence://test'] });
    await expect(verify('missing')).rejects.toThrow('intact recorded run');
    await recordRun(root, 'failed', [{ kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'failed' }]);
    await expect(verify('failed')).rejects.toThrow('successful independent QA');
    await recordRun(root, 'unfinished', [{ kind: 'qa.passed' }]);
    await expect(verify('unfinished')).rejects.toThrow('successful independent QA');
    await recordRun(root, 'unstarted', [{ kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
    await expect(verify('unstarted')).rejects.toThrow('successful independent QA');
    await recordRun(root, 'wrong-gate', [{ kind: 'qa.started' }, { kind: 'qa.passed' },
      { kind: 'change.published', changeId: '5', url: 'https://example.test/pr/5' },
      { kind: 'human_gate.opened', gateId: 'merge:6', reason: 'different change' }]);
    await expect(verify('wrong-gate')).rejects.toThrow('successful independent QA');
    await recordRun(root, 'late-failure', [{ kind: 'qa.started' }, { kind: 'qa.passed' },
      { kind: 'change.published', changeId: '5', url: 'https://example.test/pr/5' },
      { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'awaiting human merge' },
      { kind: 'qa.failed', reason: 'blocked' }]);
    await expect(verify('late-failure')).rejects.toThrow('successful independent QA');
    await recordRun(root, 'foreign', [{ kind: 'qa.passed' }], 'github:other/wiki#42');
    await expect(verify('foreign')).rejects.toThrow('another project');
    await recordRun(root, 'corrupt', [{ kind: 'qa.passed' }]);
    await fs.appendFile(join(root, `${Buffer.from('corrupt').toString('base64url')}.jsonl`), 'invalid JSON\n');
    await expect(verify('corrupt')).rejects.toThrow('intact recorded run');
  });

  it('records a structured execution failure as a candidate without retaining raw transcripts', async () => {
    const { root, store } = await fixture();
    store.close();
    vi.stubEnv('HOME', root);
    const record = recordExecutionExperience({ failure: createFailureDiagnostic({ code: 'upstream_model_error', message: 'sqlite request failed token=synthetic-secret' }), runId: 'failed-runtime', workItemId: 'github:acme/wiki#42' });
    expect(record.status).toBe('candidate');
    expect(record.scope).toBe('github:acme/wiki');
    expect(record.evidence).toEqual(['run:failed-runtime#failure.classified']);
    expect(JSON.stringify(record)).not.toContain('synthetic-secret');
    const fragments = await new ExperienceContextProvider(experienceStorePath(root)).gather({ scope: record.scope, prompt: 'sqlite' });
    expect(fragments).toEqual([]);
    await expect(new ExperienceContextProvider(experienceStorePath(root)).gather({ scope: record.scope, prompt: 'sqlite' }, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
