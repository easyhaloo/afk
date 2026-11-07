import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ObservationContext, RunEventData } from '@afk/core';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { createFailureDiagnostic } from '../workflows/failure-diagnostic.js';
import { ExperienceStore } from './experience-store.js';
import { ExperienceContextProvider, experienceScope, experienceStorePath, prepareExperienceContext, recordExecutionExperience, verifyExperienceRun } from './runtime.js';

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
