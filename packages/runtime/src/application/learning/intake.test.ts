import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ObservationContext, RunEventData } from '@afk/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { CandidateStore } from './candidate-store.js';
import { reconcileDistillationSources, submitLearningCorrection } from './intake.js';
import { LearningWorker } from './worker.js';
import { ClaudeCodeProvider } from '../../domain/agents/claude-code.js';

const roots: string[] = [];
const scope = 'github:acme/wiki';
const workItemId = `${scope}#42`;

async function fixture() {
  const homeDir = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'learning-intake-')));
  roots.push(homeDir);
  const eventRoot = join(homeDir, '.afk', 'events');
  const directory = join(homeDir, '.afk', 'learning');
  const transcriptPath = join(homeDir, '.afk', 'transcripts', 'native-session.jsonl');
  await fs.mkdir(join(homeDir, '.afk', 'transcripts'), { recursive: true });
  await fs.writeFile(transcriptPath, JSON.stringify({ type: 'user', message: { content: 'Publishing requires a review.' } }) + '\n');
  const events = new JsonlEventStore({ root: eventRoot });
  const context: ObservationContext = { traceId: 'trace-1', runId: 'run-1', workItemId, profileId: 'default',
    attempt: 1, actor: { kind: 'system', id: 'test' } };
  const append = (data: readonly RunEventData[], override: Partial<ObservationContext> = {}) => events.append(data.map(entry => ({
    id: randomUUID(), schemaVersion: 1 as const, type: entry.kind, context: { ...context, ...override },
    occurredAt: new Date().toISOString(), correlationId: context.runId, data: entry,
  })));
  const complete: RunEventData[] = [{ kind: 'qa.started' }, { kind: 'agent.session_recorded', sessionId: 'native-session', transcriptPath },
    { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }];
  const open = () => new CandidateStore({ file: join(directory, 'candidates.sqlite') });
  return { homeDir, eventRoot, directory, events, context, append, complete, open, transcriptPath };
}

afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

describe('durable learning intake', () => {
  it('captures an explicitly selected failure and rechecks it during ordinary scans', async () => {
    const input = await fixture();
    await input.append([{ kind: 'agent.session_recorded', sessionId: 'native-session', transcriptPath: input.transcriptPath },
      { kind: 'qa.failed', reason: 'Duplicate retry' }, { kind: 'run.finished', outcome: 'failed' }]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: [] });
    const selected = { ...input, scope, runId: 'run-1', workItemId, includeFailed: true };
    const captured = await reconcileDistillationSources(selected);
    expect(captured).toMatchObject({ submitted: 1, requestKeys: [expect.any(String)], blocked: [] });
    const store = input.open();
    try {
      const request = store.getRequest(captured.requestKeys[0])!;
      expect(request.request).toMatchObject({ sourceRunId: 'run-1', workItemId, reason: 'failed' });
      expect(request.request.sourceId).toMatch(/:failure:3:failed:sessions:[a-f0-9]{64}$/);
      const pack = store.getEvidencePack(request.request.evidenceDigest)!;
      expect(pack.sources.map(source => source.kind)).toEqual(['audit', 'session']);
      expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, invalidated: 0,
        requestKeys: captured.requestKeys, checkedSources: [{ runId: 'run-1', eventRoot: input.eventRoot }], blocked: [] });
      expect(store.getRequest(request.key)?.blockedReason).toBeUndefined();
    } finally { store.close(); }
  });

  it.each(['scope', 'runId', 'workItemId'] as const)('requires an explicit %s for first failure capture', async missing => {
    const input = await fixture();
    const selected = { ...input, scope, runId: 'run-1', workItemId, includeFailed: true };
    await expect(reconcileDistillationSources({ ...selected, [missing]: undefined })).rejects.toThrow('failure_source_identity_required');
  });

  it('replaces an opted-in failure epoch and withdraws it when the run later succeeds', async () => {
    const input = await fixture();
    await input.append([{ kind: 'run.finished', outcome: 'failed' }]);
    const first = await reconcileDistillationSources({ ...input, scope, runId: 'run-1', workItemId, includeFailed: true });
    await input.append([{ kind: 'qa.failed', reason: 'Retry still fails' }, { kind: 'run.finished', outcome: 'failed' }]);
    const next = await reconcileDistillationSources(input);
    expect(next).toMatchObject({ submitted: 1, invalidated: 1, requestKeys: [expect.any(String)], blocked: [] });
    expect(next.requestKeys[0]).not.toBe(first.requestKeys[0]);
    await input.append([{ kind: 'run.finished', outcome: 'succeeded' }]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, invalidated: 1, requestKeys: [], blocked: [] });
    const store = input.open();
    try { expect(store.listRequests().every(request => request.blockedReason === 'source_invalidated')).toBe(true); }
    finally { store.close(); }
  });

  it.each([{ actor: { kind: 'agent' as const, id: 'untrusted' } }, { purpose: 'learning' as const }])(
    'does not capture an untrusted or learning failure: %j', async context => {
      const input = await fixture();
      await input.append([{ kind: 'run.finished', outcome: 'failed' }], context);
      expect(await reconcileDistillationSources({ ...input, scope, runId: 'run-1', workItemId, includeFailed: true }))
        .toMatchObject({ submitted: 0, requestKeys: [] });
    });

  it.each([false, true])('rejects a mismatched work item without capturing or invalidating an existing request: replay=%s', async replay => {
    const input = await fixture();
    await input.append(input.complete);
    if (replay) await reconcileDistillationSources({ ...input, scope, runId: 'run-1' });
    const store = input.open();
    try {
      const before = store.listRequests();
      const commit = vi.spyOn(CandidateStore.prototype, 'commitScan');
      const result = await reconcileDistillationSources({ ...input, scope, runId: 'run-1', workItemId: `${scope}#43` });
      expect(result).toMatchObject({ submitted: 0, invalidated: 0, requestKeys: [],
        blocked: [{ runId: 'run-1', code: 'source_work_item_mismatch' }] });
      expect(commit).not.toHaveBeenCalled();
      expect(store.listRequests()).toEqual(before);
      expect(store.listCandidates()).toEqual([]);
      const matching = await reconcileDistillationSources({ ...input, scope, runId: 'run-1', workItemId });
      expect(matching).toMatchObject({ requestKeys: [expect.any(String)], blocked: [] });
    } finally { store.close(); }
  });

  it('returns current request keys only for the requested scope and run', async () => {
    const input = await fixture();
    const otherScope = 'github:other/wiki';
    await input.append(input.complete);
    await input.append(input.complete, { runId: 'run-2', workItemId: `${scope}#43` });
    await input.append(input.complete, { runId: 'other-1', workItemId: `${otherScope}#42` });
    await input.append(input.complete, { runId: 'analysis-1', purpose: 'learning' });
    const first = await reconcileDistillationSources(input);
    expect(first).toMatchObject({ submitted: 3, blocked: [] });
    const store = input.open();
    try {
      const entries = store.listRequests();
      expect(first.requestKeys.sort()).toEqual(entries.map(entry => entry.key).sort());
      const keyFor = (runId: string) => entries.find(entry => entry.request.sourceRunId === runId)!.key;
      expect(await reconcileDistillationSources({ ...input, scope, runId: 'run-1' }))
        .toMatchObject({ submitted: 0, requestKeys: [keyFor('run-1')], blocked: [] });
      const scoped = await reconcileDistillationSources({ ...input, scope });
      expect(scoped)
        .toMatchObject({ submitted: 0, requestKeys: expect.arrayContaining([keyFor('run-1'), keyFor('run-2')]), blocked: [] });
      expect(scoped.requestKeys).toHaveLength(2);
      expect(await reconcileDistillationSources({ ...input, scope: otherScope, runId: 'other-1' }))
        .toMatchObject({ submitted: 0, requestKeys: [keyFor('other-1')], blocked: [] });
      expect((await reconcileDistillationSources({ ...input, scope, runId: 'other-1' })).requestKeys).toEqual([]);
    } finally { store.close(); }
  });

  it('distills a missing kind from the same source without replacing an existing legacy proposal', async () => {
    const input = await fixture();
    await input.append(input.complete);
    const selected = { ...input, scope, runId: 'run-1', workItemId };
    const { requestKeys: [generic] } = await reconcileDistillationSources(selected);
    const store = input.open();
    try {
      const original = store.getRequest(generic)!;
      const evidenceIds = [original.evidence[0].id];
      const applicability = { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] };
      const fact = { kind: 'fact', title: 'Review', statement: 'Require review.', evidenceIds, applicability,
        payload: { subject: 'Review', rule: 'Require review.', classification: 'fact' } };
      const tool = { kind: 'tool', title: 'Check', statement: 'Check inputs.', evidenceIds, applicability,
        payload: { existingTools: [], inputSchema: {}, outputSchema: {}, dependencies: [], permissions: [], timeoutMs: 1000,
          sideEffects: 'none', idempotency: 'pure', recovery: 'retry', source: 'return 1',
          tests: ['normal', 'recovery', 'refusal'].map(kind => ({ kind, input: kind, expected: kind })) } };
      const receipt = store.completeRequest(generic, { version: 1, warnings: [], candidates: [fact, tool] });
      const skill = { ...selected, candidateKind: 'skill' as const };
      const focused = await reconcileDistillationSources(skill);
      const [key] = focused.requestKeys;
      expect(focused).toMatchObject({ submitted: 1, blocked: [] });
      expect(key).not.toBe(generic);
      expect(store.getRequest(key)?.request).toEqual({ ...original.request, candidateKind: 'skill' });
      expect(() => store.completeRequest(key, { version: 1, warnings: [], candidates: [fact] })).toThrow(/request kind/);
      expect(await reconcileDistillationSources(skill)).toMatchObject({ submitted: 0, requestKeys: [key] });
      expect(await reconcileDistillationSources({ ...selected, candidateKind: 'tool' })).toMatchObject({ submitted: 0, requestKeys: [generic] });
      expect(await reconcileDistillationSources(selected)).toMatchObject({ submitted: 0, requestKeys: [generic] });
      expect(store.getProcessingReceipt(generic)).toEqual(receipt);
      await input.append([{ kind: 'qa.failed', reason: 'Source withdrawn' }, { kind: 'run.finished', outcome: 'failed' }]);
      expect(await reconcileDistillationSources(selected)).toMatchObject({ invalidated: 2, requestKeys: [] });
    } finally { store.close(); }
  });

  it('returns no request keys when a new scan or replay cursor commit fails', async () => {
    const input = await fixture();
    await input.append(input.complete);
    const commit = vi.spyOn(CandidateStore.prototype, 'commitScan').mockImplementationOnce(() => { throw new Error('storage_blocked'); });
    expect(await reconcileDistillationSources(input))
      .toMatchObject({ submitted: 0, requestKeys: [], blocked: [{ code: 'storage_blocked' }] });
    const successful = await reconcileDistillationSources(input);
    expect(successful).toMatchObject({ submitted: 1, requestKeys: [expect.any(String)], blocked: [] });
    await input.append([{ kind: 'run.finished', outcome: 'succeeded' }]);
    commit.mockImplementationOnce(() => { throw new Error('storage_blocked'); });
    expect(await reconcileDistillationSources(input))
      .toMatchObject({ submitted: 0, requestKeys: [], blocked: [{ code: 'storage_blocked' }] });
    expect(await reconcileDistillationSources(input))
      .toMatchObject({ submitted: 0, requestKeys: successful.requestKeys, blocked: [] });
  });

  it('excludes an authoritatively blocked current request while retaining other successful sources', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await input.append(input.complete, { runId: 'run-2', workItemId: `${scope}#43` });
    await input.append([{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'failed' }], { runId: 'failed-1' });
    await reconcileDistillationSources(input);
    const store = input.open();
    try {
      const blocked = store.listRequests().find(entry => entry.request.sourceRunId === 'run-1')!;
      const successful = store.listRequests().find(entry => entry.request.sourceRunId === 'run-2')!;
      store.invalidateRequestSource(blocked.key);
      expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: [successful.key], blocked: [] });
      expect(store.getRequest(blocked.key)?.blockedReason).toBe('source_invalidated');
      expect(await reconcileDistillationSources({ ...input, runId: 'failed-1' })).toMatchObject({ submitted: 0, requestKeys: [] });
    } finally { store.close(); }
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('keeps an inaccessible audit retryable and recovers after directory access is restored', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    await fs.chmod(input.eventRoot, 0);
    try {
      expect(await reconcileDistillationSources({ ...input, runId: 'run-1' }))
        .toMatchObject({ invalidated: 0, blocked: [{ code: 'audit_unstable' }] });
      const store = input.open();
      try { expect(store.listRequests()[0].blockedReason).toBe('source_unstable'); }
      finally { store.close(); }
    } finally { await fs.chmod(input.eventRoot, 0o700); }
    expect(await reconcileDistillationSources(input)).toMatchObject({ invalidated: 0, blocked: [] });
    const store = input.open();
    try { expect(store.listRequests()[0].blockedReason).toBeUndefined(); }
    finally { store.close(); }
  });

  it('temporarily blocks concurrent audit appends without permanently invalidating a valid source', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    const auditPath = input.events.pathFor('run-1');
    const open = fs.open.bind(fs);
    let appended = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === auditPath && !appended) {
        appended = true;
        const read = handle.read;
        vi.spyOn(handle, 'read').mockImplementationOnce(async (...parameters) => {
          const result = await Reflect.apply(read, handle, parameters);
          await input.append([{ kind: 'run.finished', outcome: 'succeeded' }]);
          return result;
        });
      }
      return handle;
    });
    expect(await reconcileDistillationSources(input)).toMatchObject({ invalidated: 0, blocked: [{ code: 'audit_unstable' }] });
    const store = input.open();
    try {
      expect(store.listRequests()[0].blockedReason).toBe('source_unstable');
      expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, invalidated: 0, blocked: [] });
      expect(store.listRequests()[0].blockedReason).toBeUndefined();
    } finally { store.close(); }
  });

  it('retries a partial trailing audit record and never clears authoritative source invalidation', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    const auditPath = input.events.pathFor('run-1');
    const original = await fs.readFile(auditPath);
    await fs.appendFile(auditPath, '{"id":');
    expect(await reconcileDistillationSources(input)).toMatchObject({ invalidated: 0, blocked: [{ code: 'audit_unstable' }] });
    await fs.writeFile(auditPath, original);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, blocked: [] });
    const store = input.open();
    try {
      expect(store.listRequests()[0].blockedReason).toBeUndefined();
      store.setRequestBlocked(store.listRequests()[0].key, 'source_invalidated');
      await reconcileDistillationSources(input);
      expect(store.listRequests()[0].blockedReason).toBe('source_invalidated');
    } finally { store.close(); }
  });

  it.each(['negative-event', 'tampered-prefix'])('does not let an incomplete tail conceal %s in the completed audit prefix', async change => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    const auditPath = input.events.pathFor('run-1');
    if (change === 'negative-event') await input.append([{ kind: 'qa.failed' }]);
    else await fs.writeFile(auditPath, (await fs.readFile(auditPath, 'utf8')).replace('qa.passed', 'qa.failed'));
    await fs.appendFile(auditPath, '{"id":');
    expect(await reconcileDistillationSources(input)).toMatchObject({ invalidated: 1,
      blocked: [{ code: change === 'negative-event' ? 'audit_unstable' : 'audit_invalid' }] });
    const store = input.open();
    try { expect(store.listRequests()[0].blockedReason).toBe('source_invalidated'); } finally { store.close(); }
  });

  it('globally reconciles known runs even after their audit files are deleted', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    await fs.rm(input.events.pathFor('run-1'));
    expect(await reconcileDistillationSources(input)).toMatchObject({ invalidated: 1, blocked: [{ runId: 'run-1', code: 'audit_invalid' }] });
    const store = input.open();
    try { expect(store.listRequests()[0].blockedReason).toBe('source_invalidated'); } finally { store.close(); }
  });

  it('does not treat explicitly imported run identities as managed audit sources', async () => {
    const input = await fixture();
    const correction = await submitLearningCorrection({ directory: input.directory, scope, sourceId: 'imported-run', correction: 'Review before publishing.' });
    const store = input.open();
    try {
      store.submitRequest({ request: { ...correction.request, reason: 'import', sourceId: 'imported-run-identity', sourceRunId: 'outside-runtime' }, evidence: correction.evidence });
      expect(await reconcileDistillationSources(input)).toMatchObject({ invalidated: 0, blocked: [] });
      expect((await reconcileDistillationSources({ ...input, runId: 'outside-runtime' })).invalidated).toBe(0);
      expect(store.listRequests().every(entry => !entry.blockedReason)).toBe(true);
    } finally { store.close(); }
  });

  it.each([false, true])('keeps a known foreign project source outside scoped reconciliation (targeted=%s)', async targeted => {
    const input = await fixture();
    await input.append(input.complete, { workItemId: 'github:other/payments#1' });
    await reconcileDistillationSources(input);
    const auditPath = input.events.pathFor('run-1');
    await fs.writeFile(auditPath, (await fs.readFile(auditPath, 'utf8')).replace('qa.passed', 'qa.failed'));
    expect(await reconcileDistillationSources({ ...input, scope, ...(targeted ? { runId: 'run-1' } : {}) }))
      .toMatchObject({ invalidated: 0, scanned: 0, blocked: [] });
    const store = input.open();
    try { expect(store.listRequests()[0].blockedReason).toBeUndefined(); } finally { store.close(); }
    expect((await reconcileDistillationSources(input)).invalidated).toBe(1);
  });

  it('retains a transient source block until every evidence source passes revalidation', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    await fs.writeFile(input.transcriptPath, 'x'.repeat(140 * 1024));
    expect((await reconcileDistillationSources(input)).blocked).toMatchObject([{ code: 'source_limit' }]);
    let release!: () => void;
    let opened!: () => void;
    const pause = new Promise<void>(resolve => { release = resolve; });
    const reading = new Promise<void>(resolve => { opened = resolve; });
    const open = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await open(...args);
      if (args[0] === input.transcriptPath) { opened(); await pause; }
      return handle;
    });
    const pending = reconcileDistillationSources(input);
    const analyze = vi.fn(async () => ({ analysisRunId: 'must-not-start', output: { type: 'goal_complete',
      distillation: { version: 1, candidates: [], warnings: [] } } }));
    let worker: LearningWorker | undefined;
    const store = input.open();
    try {
      await reading;
      expect(store.listRequests()[0].blockedReason).toBe('source_unstable');
      worker = new LearningWorker({ directory: input.directory, enabled: true, provider: new ClaudeCodeProvider(), analyze });
      expect((await worker.runOnce()).processed).toBe(0);
      expect(analyze).not.toHaveBeenCalled();
      expect(store.getModelCallCount(new Date().toISOString().slice(0, 10))).toBe(0);
    } finally { release(); await pending; await worker?.close(); store.close(); }
  });

  it('remembers custom audit roots across global recovery and rejects a different root without withdrawing its owner', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    const otherRoot = join(input.homeDir, 'other-events');
    expect(await reconcileDistillationSources({ ...input, eventRoot: otherRoot, runId: 'run-1' })).toMatchObject({ invalidated: 0, blocked: [{ code: 'source_not_allowed' }] });
    const customRoot = join(input.homeDir, 'custom-events');
    const customEvents = new JsonlEventStore({ root: customRoot });
    const customDrafts = input.complete.map(data => ({
      id: randomUUID(), schemaVersion: 1, type: data.kind, context: { ...input.context, runId: 'custom-run' },
      occurredAt: new Date().toISOString(), correlationId: 'custom-run', data,
    } as const));
    await customEvents.append(customDrafts.slice(0, -1));
    expect((await reconcileDistillationSources({ ...input, eventRoot: customRoot, runId: 'custom-run' })).submitted).toBe(0);
    await customEvents.append(customDrafts.slice(-1));
    const global = { directory: input.directory, homeDir: input.homeDir };
    expect(await reconcileDistillationSources(global)).toMatchObject({ submitted: 1, invalidated: 0, blocked: [] });
    const store = input.open();
    try { expect(store.listRequests().every(entry => !entry.blockedReason)).toBe(true); } finally { store.close(); }
    await fs.rm(customEvents.pathFor('custom-run'));
    expect(await reconcileDistillationSources(global)).toMatchObject({ invalidated: 1, blocked: [{ runId: 'custom-run', code: 'audit_invalid' }] });
  });

  it.each(['other-project', 'learning-only'])('withdraws requests before filtering a replaced %s audit', async replacement => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    await fs.rm(input.events.pathFor('run-1'));
    await input.append(input.complete, replacement === 'other-project' ? { workItemId: 'github:other/wiki#42' } : { purpose: 'learning' });
    expect(await reconcileDistillationSources({ ...input, scope })).toMatchObject({ invalidated: 1, blocked: [{ code: 'audit_changed' }] });
    const store = input.open();
    try { expect(store.listRequests()[0].blockedReason).toBe('source_invalidated'); } finally { store.close(); }
  });

  it('processes negative evidence even when the valid audit exceeds the model evidence limit', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    await input.append([...Array.from({ length: 260 }, () => ({ kind: 'decision.made' as const, command: 'fixture.audit', accepted: true, reason: 'x'.repeat(300) })), { kind: 'qa.failed' }]);
    expect((await fs.stat(input.events.pathFor('run-1'))).size).toBeGreaterThan(128 * 1024);
    expect(await input.events.verify('run-1')).toMatchObject({ valid: true });
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, invalidated: 1, blocked: [] });
    const store = input.open();
    try { expect(store.listRequests()[0].blockedReason).toBe('source_invalidated'); } finally { store.close(); }
  });

  it('recaptures a missing transcript once its bytes arrive without requiring another audit event', async () => {
    const input = await fixture();
    await fs.rm(input.transcriptPath);
    await input.append(input.complete);
    const first = await reconcileDistillationSources(input);
    expect(first).toMatchObject({ submitted: 1, requestKeys: [expect.any(String)] });
    await fs.writeFile(input.transcriptPath, '{"role":"user","content":"Late review evidence."}\n');
    const current = await reconcileDistillationSources(input);
    expect(current).toMatchObject({ submitted: 1, requestKeys: [expect.any(String)], blocked: [] });
    expect(current.requestKeys[0]).not.toBe(first.requestKeys[0]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: current.requestKeys });
    const store = input.open();
    try {
      expect(store.listRequests()).toHaveLength(2);
      expect(store.getScanRequestKeys({ scope, runId: 'run-1', analyzerVersion: '1' }).slice().sort())
        .toEqual([...first.requestKeys, ...current.requestKeys].sort());
      const packs = store.listRequests().map(entry => store.getEvidencePack(entry.request.evidenceDigest)!);
      expect(packs.map(pack => pack.completeness).sort()).toEqual(['complete', 'partial']);
    } finally { store.close(); }
  });

  it('deduplicates successful terminal notifications following the same matching merge gate', async () => {
    const input = await fixture();
    await input.append([{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'change.published', changeId: '5', url: 'https://example.test/5' },
      { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'human review' }]);
    expect((await reconcileDistillationSources(input)).submitted).toBe(1);
    await input.append([{ kind: 'run.finished', outcome: 'succeeded' }]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, blocked: [] });
  });

  it('captures late session evidence once and deduplicates repeated session telemetry', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    const latePath = join(input.homeDir, '.afk', 'transcripts', 'late.jsonl');
    await fs.writeFile(latePath, '{"role":"user","content":"Deployment also requires approval."}\n');
    const late = { kind: 'agent.session_recorded' as const, sessionId: 'late-session', transcriptPath: latePath };
    await input.append([late]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 1, blocked: [] });
    await input.append([late, late, { kind: 'run.finished', outcome: 'succeeded' }]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, blocked: [] });
    const store = input.open();
    try {
      expect(store.listRequests()).toHaveLength(2);
      const packs = store.listRequests().map(entry => store.getEvidencePack(entry.request.evidenceDigest)!);
      expect(packs.filter(pack => JSON.stringify(pack).includes('Deployment also requires approval.'))).toHaveLength(1);
    } finally { store.close(); }
  });

  it('does not advance the scan cursor when the inbox is full and recovers after capacity is available', async () => {
    const input = await fixture();
    await input.append(input.complete);
    const seed = await submitLearningCorrection({ directory: input.directory, scope, sourceId: 'capacity-seed', correction: 'Require review.' });
    const store = input.open();
    try {
      for (let index = 1; index < 1000; index++) store.submitRequest({ request: { ...seed.request, sourceId: `capacity-${index}` }, evidence: seed.evidence });
      expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, blocked: [{ runId: 'run-1', code: 'storage_blocked' }] });
      for (let attempt = 0; attempt < 3; attempt++) {
        await input.append([{ kind: 'run.finished', outcome: 'succeeded' }]);
        expect((await reconcileDistillationSources(input)).blocked).toMatchObject([{ code: 'storage_blocked' }]);
      }
      expect(await fs.readdir(join(input.directory, 'snapshots')).catch(() => [])).toEqual([]);
      expect(store.getScanCursor({ scope, runId: 'run-1', analyzerVersion: '1' })).toBeUndefined();
      store.completeRequest(seed.key, { version: 1, warnings: [], candidates: [] });
      expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 1, blocked: [] });
      expect(store.getScanCursor({ scope, runId: 'run-1', analyzerVersion: '1' })?.sequence).toBe(7);
    } finally { store.close(); }
  });

  it('persists negative audit evidence when the ledger admission quota is full', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    const store = input.open();
    let candidateId: string;
    try {
      const entry = store.listRequests()[0];
      candidateId = store.completeRequest(entry.key, { version: 1, warnings: [], candidates: [{ kind: 'fact', title: 'Review', statement: 'Require review.',
        evidenceIds: [entry.evidence[0].id], applicability: { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
        payload: { subject: 'publishing', rule: 'Require review', classification: 'proposal' } }] }).candidateIds[0];
      let full = false;
      for (let index = 0; index < 2000; index++) {
        try { store.reserveModelCall({ day: '2026-11-09', callId: `capacity-${index}`, limit: 10000 }); }
        catch (error) { expect(String(error)).toMatch(/capacity/i); full = true; break; }
      }
      expect(full).toBe(true);
      await input.append([{ kind: 'qa.failed' }]);
      expect(await reconcileDistillationSources(input)).toMatchObject({ invalidated: 1 });
      expect(store.getRequest(entry.key)?.blockedReason).toBe('source_invalidated');
      expect(store.getCandidate(candidateId)?.state).toBe('conflict');
    } finally { store.close(); }
  });

  it('withdraws prior requests when a run changes purpose or its signed prefix is replaced', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    await input.append([{ kind: 'run.finished', outcome: 'succeeded' }], { purpose: 'learning' });
    expect(await reconcileDistillationSources(input)).toMatchObject({ invalidated: 1, blocked: [{ code: 'audit_invalid' }] });
    await fs.rm(input.events.pathFor('run-1'));
    await input.append([{ kind: 'run.started' }, ...input.complete]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, blocked: [{ code: 'audit_changed' }] });
    const store = input.open();
    try {
      expect(store.listRequests()).toHaveLength(1);
      expect(store.listRequests()[0].blockedReason).toBe('source_invalidated');
    } finally { store.close(); }
  });

  it('recovers a completed audit without an earlier producer and deduplicates duplicate terminal facts', async () => {
    const input = await fixture();
    await input.append(input.complete);
    const first = await reconcileDistillationSources(input);
    expect(first).toMatchObject({ submitted: 1, requestKeys: [expect.any(String)], blocked: [] });
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: first.requestKeys, blocked: [] });
    await input.append([{ kind: 'run.finished', outcome: 'succeeded' }]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: first.requestKeys, blocked: [] });
    const store = input.open();
    try {
      const [entry] = store.listRequests();
      expect(first.requestKeys).toEqual([entry.key]);
      expect(store.listRequests()).toHaveLength(1);
      expect(entry.request).toMatchObject({ scope, sourceRunId: 'run-1', workItemId, reason: 'completed' });
      const pack = store.getEvidencePack(entry.request.evidenceDigest)!;
      expect(JSON.stringify(pack)).toContain('Publishing requires a review.');
      expect(store.getScanCursor({ scope, runId: 'run-1', analyzerVersion: '1' })?.sequence).toBe(5);
    } finally { store.close(); }
  });

  it('requires independent QA and ignores learning-purpose runs and other projects', async () => {
    const input = await fixture();
    await input.append([{ kind: 'run.finished', outcome: 'succeeded' }]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: [] });
    await input.append(input.complete, { runId: 'analysis-1', purpose: 'learning' });
    await input.append(input.complete, { runId: 'other-1', workItemId: 'github:other/wiki#42' });
    expect(await reconcileDistillationSources({ ...input, scope })).toMatchObject({ submitted: 0, requestKeys: [] });
    const store = input.open();
    try { expect(store.listRequests()).toEqual([]); } finally { store.close(); }
  });

  it('withdraws the source and candidate after late QA failure without inventing a new successful job', async () => {
    const input = await fixture();
    await input.append(input.complete);
    await reconcileDistillationSources(input);
    let store = input.open();
    let candidateId: string;
    try {
      const [entry] = store.listRequests();
      const receipt = store.completeRequest(entry.key, { version: 1, warnings: [], candidates: [{ kind: 'fact', title: 'Review', statement: 'Review before publishing.',
        evidenceIds: [entry.evidence[0].id], applicability: { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
        payload: { subject: 'publishing', rule: 'Review before publishing', classification: 'proposal' } }] });
      candidateId = receipt.candidateIds[0];
    } finally { store.close(); }
    await input.append([{ kind: 'qa.failed', summary: 'The review assertion was disproved.' }]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: [], invalidated: 1 });
    store = input.open();
    try {
      expect(store.listRequests()[0].blockedReason).toBe('source_invalidated');
      expect(store.getCandidate(candidateId!)).toMatchObject({ state: 'conflict' });
    } finally { store.close(); }
  });

  it('creates a new repaired checkpoint after QA restarts while retaining withdrawn history', async () => {
    const input = await fixture();
    await input.append(input.complete);
    const first = await reconcileDistillationSources(input);
    await input.append([{ kind: 'qa.failed' }, { kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
    const current = await reconcileDistillationSources(input);
    expect(current).toMatchObject({ submitted: 1, requestKeys: [expect.any(String)], invalidated: 1 });
    expect(current.requestKeys[0]).not.toBe(first.requestKeys[0]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: current.requestKeys });
    const store = input.open();
    try {
      expect(store.listRequests()).toHaveLength(2);
      expect(current.requestKeys).toEqual([store.listRequests().find(entry => !entry.blockedReason)!.key]);
      expect(store.listRequests().find(entry => !entry.blockedReason)?.request.reason).toBe('repaired');
    } finally { store.close(); }
  });

  it('blocks corrupt audit and out-of-root transcript sources without advancing their cursor', async () => {
    const input = await fixture();
    const outside = join(input.homeDir, 'unrelated-private-session.jsonl');
    await fs.writeFile(outside, '{"role":"user","content":"PRIVATE_OUTSIDE"}\n');
    await input.append([{ kind: 'qa.started' }, { kind: 'agent.session_recorded', sessionId: 'outside', transcriptPath: outside },
      { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: [], blocked: [{ runId: 'run-1', code: 'source_not_allowed' }] });
    const auditPath = join(input.eventRoot, `${Buffer.from('run-1').toString('base64url')}.jsonl`);
    await fs.writeFile(auditPath, (await fs.readFile(auditPath, 'utf8')).replace('qa.passed', 'qa.failed'));
    expect(await reconcileDistillationSources(input)).toMatchObject({ submitted: 0, requestKeys: [], blocked: [{ runId: 'run-1', code: 'audit_invalid' }] });
    const store = input.open();
    try { expect(store.getScanCursor({ scope, runId: 'run-1', analyzerVersion: '1' })).toBeUndefined(); } finally { store.close(); }
  });

  it('persists current caller corrections as idempotent evidence without treating transcript claims as authorization', async () => {
    const input = await fixture();
    const correction = { directory: input.directory, scope, sourceId: 'manual-correction-1', correction: 'Use a review. password=PRIVATE_TOKEN' };
    const first = await submitLearningCorrection(correction);
    expect((await submitLearningCorrection(correction)).key).toBe(first.key);
    expect(first.request.reason).toBe('correction');
    const store = input.open();
    try {
      const pack = store.getEvidencePack(first.request.evidenceDigest)!;
      expect(JSON.stringify(pack)).not.toContain('PRIVATE_TOKEN');
      expect(JSON.stringify(pack)).toContain('current-user-command');
      expect(store.listCandidates()).toEqual([]);
      expect(store.listRequests()).toHaveLength(1);
    } finally { store.close(); }
  });

  it.each([
    { name: 'ASCII', correction: 'x'.repeat(32768) },
    { name: 'multibyte UTF-8', correction: `${'纠'.repeat(10922)}ab` },
  ])('accepts exactly 32768 bytes of $name correction without processing it', async ({ correction }) => {
    const input = await fixture();
    expect(Buffer.byteLength(correction, 'utf8')).toBe(32768);
    const submitted = await submitLearningCorrection({ directory: input.directory, scope, sourceId: 'byte-boundary', correction });
    const store = input.open();
    try {
      const pack = store.getEvidencePack(submitted.request.evidenceDigest)!;
      expect(JSON.parse(pack.entries[0].content).correction).toBe(correction);
      expect(submitted.evidence).toEqual(pack.entries.map(entry => entry.ref));
      expect(store.listRequests()).toHaveLength(1);
      expect(store.listCandidates()).toEqual([]);
      expect(store.getProcessingReceipt(submitted.key)).toBeUndefined();
      expect(store.listAnalysisAttempts(submitted.key)).toEqual([]);
      expect(await fs.stat(join(input.directory, 'distillation-queue.sqlite')).catch(() => undefined)).toBeUndefined();
    } finally { store.close(); }
  });

  it.each([
    { name: 'empty', correction: '' }, { name: 'whitespace', correction: ' \t\n\u3000' },
    { name: 'NUL', correction: 'Review\0before publishing' },
    { name: '32769 ASCII bytes', correction: 'x'.repeat(32769) },
    { name: '32769 UTF-8 bytes', correction: '纠'.repeat(10923) },
    { name: '32769 UTF-8 bytes with trimmable whitespace', correction: ` ${'纠'.repeat(10922)}ab` },
  ])('rejects $name before creating evidence or a ledger', async ({ correction }) => {
    const input = await fixture();
    const mkdtemp = vi.spyOn(fs, 'mkdtemp');
    await expect(submitLearningCorrection({ directory: input.directory, scope, sourceId: 'invalid-text', correction }))
      .rejects.toMatchObject({ name: 'ZodError' });
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(await fs.stat(input.directory).catch(() => undefined)).toBeUndefined();
  });

  it.each([0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN])('rejects invalid correction target version %s before creating evidence or a ledger', async expectedVersion => {
    const input = await fixture();
    const mkdtemp = vi.spyOn(fs, 'mkdtemp');
    await expect(submitLearningCorrection({ directory: input.directory, scope, sourceId: 'invalid-version', correction: 'Require review.',
      target: { candidateId: 'a'.repeat(64), expectedVersion } })).rejects.toMatchObject({ name: 'ZodError' });
    expect(mkdtemp).not.toHaveBeenCalled();
    expect(await fs.stat(input.directory).catch(() => undefined)).toBeUndefined();
  });

  it('binds a correction to the stored candidate snapshot and creates an independent unvalidated candidate on processing', async () => {
    const input = await fixture();
    const seed = await submitLearningCorrection({ directory: input.directory, scope, sourceId: 'seed', correction: 'Require review.' });
    const store = input.open();
    try {
      const proposal = { kind: 'fact', title: 'Review', statement: 'Require review.', evidenceIds: [seed.evidence[0].id],
        applicability: { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
        payload: { subject: 'publishing', rule: 'Require review', classification: 'proposal' } };
      const id = store.completeRequest(seed.key, { version: 1, warnings: [], candidates: [proposal] }).candidateIds[0];
      const original = store.getCandidate(id)!;
      const correction = { directory: input.directory, scope, sourceId: `candidate:${id}`, correction: 'Only releases require review. password=PRIVATE_TOKEN',
        target: { candidateId: id, expectedVersion: original.version } };
      const submitted = await submitLearningCorrection(correction);
      expect((await submitLearningCorrection(correction)).key).toBe(submitted.key);
      expect(submitted.key).not.toBe(seed.key);
      expect(submitted.request.reason).toBe('correction');
      expect(store.getCandidate(id)).toEqual(original);
      expect(store.listCandidates()).toHaveLength(1);
      const pack = store.getEvidencePack(submitted.request.evidenceDigest)!;
      expect(JSON.stringify(pack)).not.toContain('PRIVATE_TOKEN');
      const document = JSON.parse(pack.entries[0].content);
      expect(document.target).toEqual({ candidateId: original.id, candidateVersion: original.version, candidateDigest: original.digest,
        evidenceDigest: original.evidenceDigest, state: original.state, proposal: original.proposal });
      store.close();
      const reopened = input.open();
      try {
        expect(reopened.getEvidencePack(submitted.request.evidenceDigest)).toEqual(pack);
        const receipt = reopened.completeRequest(submitted.key, { version: 1, warnings: [],
          candidates: [{ ...proposal, statement: 'Only releases require review.', evidenceIds: [submitted.evidence[0].id] }] });
        expect(receipt.candidateIds[0]).not.toBe(id);
        expect(reopened.getCandidate(receipt.candidateIds[0])).toMatchObject({ state: 'candidate', version: 1, requestKey: submitted.key });
        expect(reopened.getCandidate(id)).toEqual(original);
        expect(reopened.getCandidateVersions(id)).toHaveLength(1);
        expect(reopened.listCandidates()).toHaveLength(2);
        expect(reopened.getCandidateVersions(receipt.candidateIds[0])).toHaveLength(1);
        expect(reopened.listAnalysisAttempts(submitted.key)).toEqual([]);
        expect(await fs.stat(join(input.directory, 'distillation-queue.sqlite')).catch(() => undefined)).toBeUndefined();
      } finally { reopened.close(); }
    } finally { store.close(); }
  });

  it('rejects absent, foreign and stale correction targets without admitting a new request', async () => {
    const input = await fixture();
    const correction = { directory: input.directory, scope, sourceId: 'candidate:missing', correction: 'Require review.',
      target: { candidateId: 'a'.repeat(64), expectedVersion: 1 } };
    for (const expectedVersion of [1, Number.MAX_SAFE_INTEGER]) {
      await expect(submitLearningCorrection({ ...correction, target: { ...correction.target, expectedVersion } }))
        .rejects.toThrow('correction_target_unavailable');
    }
    expect(await fs.stat(join(input.directory, 'candidates.sqlite')).catch(() => undefined)).toBeUndefined();
    const seed = await submitLearningCorrection({ directory: input.directory, scope, sourceId: 'seed', correction: 'Require review.' });
    const store = input.open();
    try {
      const id = store.completeRequest(seed.key, { version: 1, warnings: [], candidates: [{ kind: 'fact', title: 'Review', statement: 'Require review.',
        evidenceIds: [seed.evidence[0].id], applicability: { project: scope, environments: [], versions: [], preconditions: [], exclusions: [], invalidationConditions: [] },
        payload: { subject: 'publishing', rule: 'Require review', classification: 'proposal' } }] }).candidateIds[0];
      for (const change of [{ scope: 'github:other/wiki', target: { candidateId: id, expectedVersion: 1 } },
        { target: { candidateId: id, expectedVersion: 2 } }]) {
        await expect(submitLearningCorrection({ ...correction, ...change })).rejects.toThrow('correction_target_unavailable');
      }
      expect(store.listRequests()).toHaveLength(1);
      expect(store.listCandidates()).toHaveLength(1);
      const original = store.transitionCandidate(id, 1, 'rejected');
      await expect(submitLearningCorrection({ ...correction, target: { candidateId: id, expectedVersion: 1 } }))
        .rejects.toThrow('correction_target_unavailable');
      expect(store.listRequests()).toHaveLength(1);
      const accepted = await submitLearningCorrection({ ...correction, target: { candidateId: id, expectedVersion: original.version } });
      expect(store.listRequests()).toHaveLength(2);
      expect(store.getCandidate(id)).toEqual(original);
      expect(store.getCandidateVersions(id)).toHaveLength(2);
      expect(store.listCandidates()).toHaveLength(1);
      expect(store.listAnalysisAttempts(accepted.key)).toEqual([]);
    } finally { store.close(); }
  });
});
