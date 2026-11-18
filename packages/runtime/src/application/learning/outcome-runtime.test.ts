import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { ObservationContext, RunEventData } from '@afk/core';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { createPluginRunObserver } from '../plugins/observability.js';
import { createLearningPlugin } from '../plugins/learning.js';
import { ExperienceStore } from './experience-store.js';
import { ExperienceContextProvider, experienceStorePath, recordExperienceOutcomes } from './runtime.js';

const roots: string[] = [];
const stores: ExperienceStore[] = [];
const plugins: PluginRuntime[] = [];
const source = { runId: 'consumer', workItemId: 'github:acme/wiki#2' };
const scope = 'github:acme/wiki';
const selectedAt = '2026-11-16T00:00:00.000Z';
const outcomeAt = '2026-11-16T00:00:01.000Z';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

afterEach(async () => {
  vi.restoreAllMocks();
  for (const runtime of plugins.splice(0)) await runtime.dispose();
  for (const store of stores.splice(0)) store.close();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(selected = true) {
  const homeDir = await mkdtemp(join(tmpdir(), 'outcome-runtime-'));
  roots.push(homeDir);
  const file = experienceStorePath(homeDir);
  const store = new ExperienceStore({ file, now: () => new Date(selectedAt) });
  stores.push(store);
  const record = store.recordFailure({ scope, trigger: 'qa_rework', rootCause: 'Independent QA rework',
    action: 'Inspect the qa_rework evidence and validate a correction before retrying.',
    source: { runId: 'original-failure', workItemId: 'github:acme/wiki#1' }, evidence: ['run:original-failure#failure.classified'] });
  store.verify(record.id, { runId: 'independent-qa', evidence: ['run:independent-qa#regression'] });
  const retrieved = store.recordContextRetrieval({ id: record.id, scope, source,
    selectionId: randomUUID(), fragmentDigest: digest('retrieved context') });
  if (selected) store.recordContextSelection({ retrieved, fragmentDigest: digest('final context') });
  const root = join(homeDir, 'events');
  return { homeDir, file, store, record, root };
}

function context(overrides: Partial<ObservationContext> = {}): ObservationContext {
  return { traceId: 'trace', ...source, profileId: 'local', attempt: 1, actor: { kind: 'system', id: 'runner' }, ...overrides };
}

async function append(root: string, data: RunEventData, options: { context?: Partial<ObservationContext>; time?: string } = {}) {
  const eventContext = context(options.context);
  const time = options.time ?? outcomeAt;
  return new JsonlEventStore({ root, now: () => new Date(time) }).append([{ id: randomUUID(), schemaVersion: 1,
    type: data.kind, occurredAt: time, correlationId: eventContext.runId, context: eventContext, data }]);
}

describe('audited experience outcomes', () => {
  it('binds a persisted success to the exact selected snapshot without granting adoption or benefit', async () => {
    const test = await fixture();
    const audit = await append(test.root, { kind: 'run.finished', outcome: 'succeeded' });
    const receipts = await recordExperienceOutcomes({ ...source, file: test.file, root: test.root,
      event: { sequence: audit.lastSequence, hash: audit.lastHash } });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ stage: 'outcome', selected: { experienceId: test.record.id, source,
      fragmentDigest: digest('final context'), retrievedFragmentDigest: digest('retrieved context') },
    event: { type: 'run.finished', runId: source.runId, sequence: 1, hash: audit.lastHash, outcome: 'succeeded' },
    recurrence: false, benefit: 'unknown' });
    expect(test.store.metrics({ scope }).adoptions).toBe(0);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual(receipts);
  });

  it('replays success and late failure with original receipts and increments matching recurrence once', async () => {
    const test = await fixture();
    await append(test.root, { kind: 'run.finished', outcome: 'succeeded' });
    const first = await recordExperienceOutcomes({ ...source, file: test.file, root: test.root });
    await append(test.root, { kind: 'qa.failed', reason: 'rework' }, { time: '2026-11-16T00:00:02.000Z' });
    const replay = await recordExperienceOutcomes({ ...source, file: test.file, root: test.root });
    expect(replay).toHaveLength(2);
    expect(replay[0]).toEqual(first[0]);
    expect(replay[1]).toMatchObject({ recurrence: true, benefit: 'unknown', selected: first[0].selected });
    expect(test.store.metrics({ scope }).recurrences).toBe(1);
    expect(await recordExperienceOutcomes({ ...source, file: test.file, root: test.root })).toEqual(replay);
    expect(test.store.metrics({ scope }).recurrences).toBe(1);
  });

  it('rejects an append receipt that does not identify the persisted event', async () => {
    const test = await fixture();
    await append(test.root, { kind: 'run.finished', outcome: 'failed' });
    await expect(recordExperienceOutcomes({ ...source, file: test.file, root: test.root,
      event: { sequence: 1, hash: digest('other event') } })).rejects.toThrow(/persisted audit receipt/);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
  });

  it('rejects altered audit bytes before recording any outcomes', async () => {
    const test = await fixture();
    await append(test.root, { kind: 'run.finished', outcome: 'succeeded' });
    const path = new JsonlEventStore({ root: test.root }).pathFor(source.runId);
    await writeFile(path, (await readFile(path, 'utf8')).replace('succeeded', 'failed'));
    await expect(recordExperienceOutcomes({ ...source, file: test.file, root: test.root })).rejects.toThrow(/intact audit/);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
  });

  it('rejects a valid chain containing another work item before recording any outcomes', async () => {
    const test = await fixture();
    await append(test.root, { kind: 'run.finished', outcome: 'succeeded' });
    await append(test.root, { kind: 'qa.failed' }, { context: { workItemId: 'github:acme/wiki#3' } });
    await expect(recordExperienceOutcomes({ ...source, file: test.file, root: test.root })).rejects.toThrow(/exact run and work item/);
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
  });

  it.each(['agent', 'human', 'policy'] as const)('does not attribute an outcome reported by %s', async actor => {
    const test = await fixture();
    await append(test.root, { kind: 'run.finished', outcome: 'succeeded' }, { context: { actor: { kind: actor, id: 'external' } } });
    expect(await recordExperienceOutcomes({ ...source, file: test.file, root: test.root })).toEqual([]);
  });

  it('does not learn from a learning run or independent QA pass alone', async () => {
    const test = await fixture();
    await append(test.root, { kind: 'run.finished', outcome: 'succeeded' }, { context: { purpose: 'learning' } });
    await append(test.root, { kind: 'qa.passed' });
    expect(await recordExperienceOutcomes({ ...source, file: test.file, root: test.root })).toEqual([]);
    expect(test.store.metrics({ scope }).adoptions).toBe(0);
  });

  it('does not associate preselection events or failure with retrieved-only context', async () => {
    const test = await fixture(false);
    await append(test.root, { kind: 'qa.failed', reason: 'rework' });
    expect(await recordExperienceOutcomes({ ...source, file: test.file, root: test.root })).toEqual([]);
    expect(test.store.get(test.record.id, scope)?.status).toBe('verified');
    expect(test.store.metrics({ scope }).recurrences).toBe(0);
    const selected = await fixture();
    await append(selected.root, { kind: 'qa.failed', reason: 'rework' }, { time: selectedAt });
    expect(await recordExperienceOutcomes({ ...source, file: selected.file, root: selected.root })).toEqual([]);
    expect(selected.store.get(selected.record.id, scope)?.status).toBe('verified');
  });

  it('does not create a ledger while observing a run without experience storage', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'outcome-no-ledger-'));
    roots.push(homeDir);
    const root = join(homeDir, 'events');
    await append(root, { kind: 'run.finished', outcome: 'failed' });
    expect(await recordExperienceOutcomes({ ...source, homeDir, root })).toEqual([]);
    expect(existsSync(experienceStorePath(homeDir))).toBe(false);
  });
});

describe('production observation feedback', () => {
  it.each(['explicit-relative', 'environment-relative', 'explicit-absolute'] as const)(
    'shares an absolute audit root with real learning capture (%s)', async mode => {
      const test = await fixture();
      const runtime = new PluginRuntime();
      plugins.push(runtime);
      await runtime.load({ manifest: { id: 'context.test-relative-root', version: '1.0.0', apiVersion: 1,
        trusted: true, provides: ['context.provider'] }, activate(setup) {
        setup.registerContextProvider('context.experience', new ExperienceContextProvider(test.file));
      } });
      await runtime.load(createLearningPlugin({ homeDir: await realpath(test.homeDir), config: { enabled: true, dailyCalls: 0 } }));
      const dispatch = vi.spyOn(runtime, 'dispatchSystemAction');
      const root = mode === 'explicit-absolute' ? test.root : relative(process.cwd(), test.root);
      if (mode === 'environment-relative') vi.stubEnv('AFK_EVENT_STORE_DIR', root);
      const observer = mode === 'environment-relative' ? createPluginRunObserver(runtime) : createPluginRunObserver(runtime, root);
      await observer.record(context(), { kind: 'qa.started' });
      await observer.record(context(), { kind: 'qa.passed', durationMs: 1 });
      const receipt = await observer.record(context(), { kind: 'run.finished', outcome: 'succeeded' });
      const captureIndex = dispatch.mock.calls.findIndex(([name]) => name === 'learning.capture');
      expect(captureIndex).toBeGreaterThanOrEqual(0);
      expect(dispatch.mock.calls[captureIndex]).toEqual(['learning.capture', { scope, runId: source.runId, eventRoot: resolve(test.root) }]);
      expect(await dispatch.mock.results[captureIndex].value).toMatchObject({ scanned: 1, submitted: 1,
        checkedSources: [{ runId: source.runId, eventRoot: resolve(test.root) }], blocked: [] });
      expect(test.store.outcomeReceipts({ scope, source })).toMatchObject([{ selected: { experienceId: test.record.id },
        event: { hash: receipt.lastHash, sequence: receipt.lastSequence, outcome: 'succeeded' } }]);
      expect(await runtime.dispatchSystemAction('learning.jobs', { scope })).toHaveLength(1);
      expect((await new JsonlEventStore({ root: test.root }).verify(source.runId)).valid).toBe(true);
    });

  async function configured(enabled = false) {
    const test = await fixture();
    const runtime = new PluginRuntime();
    plugins.push(runtime);
    const capture = vi.fn(async () => ({ blocked: [] }));
    await runtime.load({ manifest: { id: 'context.test-experience', version: '1.0.0', apiVersion: 1,
      trusted: true, provides: ['context.provider', 'workflow.action'] },
    activate(setup) {
      setup.registerContextProvider('context.experience', new ExperienceContextProvider(test.file, { homeDir: test.homeDir }));
      setup.registerSystemAction('learning.settings', () => ({ enabled }));
      setup.registerSystemAction('learning.capture', capture);
    } });
    return { ...test, runtime, capture };
  }

  it('shares the default audit root with feedback and learning when the provider has a different home', async () => {
    const home = await mkdtemp(join(tmpdir(), 'outcome-audit-home-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('AFK_EVENT_STORE_DIR', '');
    delete process.env.AFK_EVENT_STORE_DIR;
    const test = await configured(true);
    expect(test.homeDir).not.toBe(home);
    const root = join(home, '.afk', 'events');
    const receipt = await createPluginRunObserver(test.runtime).record(context(), { kind: 'run.finished', outcome: 'succeeded' });
    expect((await new JsonlEventStore({ root }).verify(source.runId)).valid).toBe(true);
    expect(test.store.outcomeReceipts({ scope, source })).toMatchObject([{ selected: { experienceId: test.record.id },
      event: { hash: receipt.lastHash, sequence: receipt.lastSequence, outcome: 'succeeded' }, benefit: 'unknown' }]);
    expect(test.capture).toHaveBeenCalledTimes(1);
    expect(test.capture).toHaveBeenCalledWith({ scope, runId: source.runId, eventRoot: root });
    expect(existsSync(join(test.homeDir, '.afk', 'events'))).toBe(false);
  });

  it('cold-replays the default audit independently of the provider home after derived insertion fails', async () => {
    const home = await mkdtemp(join(tmpdir(), 'outcome-cold-audit-home-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('AFK_EVENT_STORE_DIR', '');
    delete process.env.AFK_EVENT_STORE_DIR;
    const test = await configured();
    const insertion = vi.spyOn(ExperienceStore.prototype, 'recordRunOutcome').mockImplementationOnce(() => { throw new Error('injected outcome failure'); });
    const receipt = await createPluginRunObserver(test.runtime).record(context(), { kind: 'run.finished', outcome: 'cancelled' });
    insertion.mockRestore();
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
    expect((await new JsonlEventStore({ root: join(home, '.afk', 'events') }).verify(source.runId)).valid).toBe(true);
    test.store.close();
    stores.splice(stores.indexOf(test.store), 1);
    const cold = new ExperienceContextProvider(undefined, { homeDir: test.homeDir });
    const replay = await cold.recordOutcomes(source);
    expect(replay).toMatchObject([{ selected: { experienceId: test.record.id },
      event: { hash: receipt.lastHash, sequence: receipt.lastSequence, outcome: 'cancelled' }, benefit: 'unknown' }]);
    expect(await cold.recordOutcomes(source)).toEqual(replay);
    const reopened = new ExperienceStore({ file: test.file });
    stores.push(reopened);
    expect(reopened.outcomeReceipts({ scope, source })).toEqual(replay);
    expect(reopened.metrics({ scope }).adoptions).toBe(0);
  });

  it.each(['HOME', 'AFK_EVENT_STORE_DIR'] as const)('pins the audit root across %s changes and cold replay', async variable => {
    const home = await mkdtemp(join(tmpdir(), 'outcome-pinned-audit-home-'));
    roots.push(home);
    vi.stubEnv('HOME', home);
    vi.stubEnv('AFK_EVENT_STORE_DIR', '');
    delete process.env.AFK_EVENT_STORE_DIR;
    const test = await configured(true);
    const observer = createPluginRunObserver(test.runtime);
    const root = join(home, '.afk', 'events');
    const changed = join(home, 'changed');
    vi.stubEnv(variable, changed);
    const receipt = await observer.record(context(), { kind: 'run.finished', outcome: 'succeeded' });
    await observer.record(context(), { kind: 'qa.failed', reason: 'rework' });
    expect((await new JsonlEventStore({ root }).verify(source.runId)).valid).toBe(true);
    const outcomes = test.store.outcomeReceipts({ scope, source });
    expect(outcomes).toMatchObject([
      { selected: { experienceId: test.record.id }, event: { type: 'qa.failed' }, recurrence: true, benefit: 'unknown' },
      { selected: { experienceId: test.record.id }, event: { hash: receipt.lastHash, sequence: receipt.lastSequence, outcome: 'succeeded' } },
    ]);
    expect(test.capture).toHaveBeenCalledTimes(2);
    expect(test.capture).toHaveBeenNthCalledWith(1, { scope, runId: source.runId, eventRoot: root });
    expect(test.capture).toHaveBeenNthCalledWith(2, { scope, runId: source.runId, eventRoot: root });
    expect(existsSync(changed)).toBe(false);
    expect(existsSync(join(test.homeDir, '.afk', 'events'))).toBe(false);
    test.store.close();
    stores.splice(stores.indexOf(test.store), 1);
    const cold = new ExperienceContextProvider(undefined, { homeDir: test.homeDir });
    const replay = [...outcomes].sort((left, right) => left.event.sequence - right.event.sequence);
    expect(await cold.recordOutcomes({ ...source, root })).toEqual(replay);
    expect(await cold.recordOutcomes({ ...source, root })).toEqual(replay);
    const reopened = new ExperienceStore({ file: test.file });
    stores.push(reopened);
    expect(reopened.outcomeReceipts({ scope, source })).toEqual(outcomes);
    expect(reopened.metrics({ scope }).recurrences).toBe(1);
    expect(reopened.metrics({ scope }).adoptions).toBe(0);
  });

  it('records outcomes through the selected provider when model-based learning is disabled', async () => {
    const test = await configured();
    const receipt = await createPluginRunObserver(test.runtime, test.root).record(context(), { kind: 'run.finished', outcome: 'succeeded' });
    expect(test.store.outcomeReceipts({ scope, source })).toMatchObject([{ selected: { experienceId: test.record.id },
      event: { hash: receipt.lastHash, sequence: receipt.lastSequence, outcome: 'succeeded' }, benefit: 'unknown' }]);
    expect(test.capture).not.toHaveBeenCalled();
  });

  it('retains audit evidence for recovery when derived outcome insertion fails', async () => {
    const test = await configured();
    const insertion = vi.spyOn(ExperienceStore.prototype, 'recordRunOutcome').mockImplementationOnce(() => { throw new Error('injected outcome failure'); });
    const receipt = await createPluginRunObserver(test.runtime, test.root).record(context(), { kind: 'run.finished', outcome: 'cancelled' });
    insertion.mockRestore();
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
    expect((await new JsonlEventStore({ root: test.root }).verify(source.runId)).valid).toBe(true);
    expect(await recordExperienceOutcomes({ ...source, file: test.file, root: test.root,
      event: { sequence: receipt.lastSequence, hash: receipt.lastHash } })).toMatchObject([{ event: { outcome: 'cancelled' }, benefit: 'unknown' }]);
  });

  it('still captures a learning request when outcome insertion fails', async () => {
    const test = await configured(true);
    vi.spyOn(ExperienceStore.prototype, 'recordRunOutcome').mockImplementationOnce(() => { throw new Error('injected outcome failure'); });
    await createPluginRunObserver(test.runtime, test.root).record(context(), { kind: 'run.finished', outcome: 'failed' });
    expect(test.capture).toHaveBeenCalledTimes(1);
    expect(test.capture).toHaveBeenCalledWith({ scope, runId: source.runId, eventRoot: test.root });
    expect(test.store.outcomeReceipts({ scope, source })).toEqual([]);
  });
});
