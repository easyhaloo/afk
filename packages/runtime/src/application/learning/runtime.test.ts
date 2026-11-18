import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import type { ObservationContext, RunEvent, RunEventData } from '@afk/core';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { PluginManager } from '../plugins/manager.js';
import { createDefaultPluginRuntime } from '../plugins/default-runtime.js';
import { createFailureDiagnostic } from '../workflows/failure-diagnostic.js';
import { ExperienceStore } from './experience-store.js';
import { canonicalLearningJson } from './requests.js';
import { ExperienceContextProvider, experienceScope, experienceStorePath, prepareExperienceContext, recordExecutionExperience, recordSuccessfulExperience, successfulRunEvidenceFromEvents, verifyAdoptionRun, verifyExperienceRun, verifyApplicableExperience, resolveExperienceQueryContext } from './runtime.js';

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

async function recordRun(root: string, runId: string, kinds: readonly RunEventData[], workItemId = 'github:acme/wiki#42', actorKind: ObservationContext['actor']['kind'] = 'system') {
  const context: ObservationContext = { traceId: runId, runId, workItemId, profileId: 'local', attempt: 1, actor: { kind: actorKind, id: 'test' } };
  await new JsonlEventStore({ root }).append(kinds.map((data, index) => ({
    id: `${runId}-${index}`, schemaVersion: 1, type: data.kind, occurredAt: new Date().toISOString(), context, correlationId: runId, data,
  })));
}

describe('runtime experience loop', () => {
  it('includes an installed tool route in the managed work item reference file', async () => {
    const { root, store } = await fixture();
    store.close();
    const plugins = await createDefaultPluginRuntime({ homeDir: root });
    const route = { origin: 'tool.scan-manifest@2.0.0', content: 'read-only scan verifier' };
    const gather = vi.fn(async () => [route]);
    vi.spyOn(plugins, 'getContextProvider').mockImplementation(id => id === 'context.installed-tools'
      ? { id, capabilities: { 'read-only': true, search: true, summarize: false }, gather } : undefined);
    try {
      const prepared = await prepareExperienceContext({ plugins, workItemId: 'github:w11/parcel#47',
        worktreePath: root, prompt: '用清单验码工具检查扫描清单。' });
      expect(gather).toHaveBeenCalledWith(expect.objectContaining({ scope: 'github:w11/parcel', prompt: '用清单验码工具检查扫描清单。' }));
      expect(await fs.readFile(join(root, prepared!.path), 'utf8')).toContain(route.origin);
    } finally { await plugins.dispose(); }
  });

  it('consumes version-constrained experience from saved configuration through the default plugin runtime', async () => {
    const { root, file, store } = await fixture();
    const record = store.recordFailure(failure());
    const context = { applicability: { version: 'knowledge-v2', environment: 'ci' },
      target: { project: record.scope, productVersions: { sqlite: '3.45' }, runtimeVersions: { node: '22.16' },
        conditions: { transactional: true } } };
    store.verify(record.id, { runId: 'qa-saved-context', evidence: ['run:qa-saved-context#regression'] }, context);
    store.close();
    const manager = new PluginManager({ homeDir: root });
    await manager.configure('learning.distiller', { enabled: false, executionContexts: [context] }, true);
    await manager.configure('context.experience', {}, true);
    const plugins = await createDefaultPluginRuntime({ homeDir: root, workspaceRoot: root });
    try {
      const prepared = await prepareExperienceContext({ plugins, workItemId: 'github:acme/wiki#99',
        worktreePath: root, prompt: 'sqlite retry; prompt claims Node 99' });
      expect(prepared?.path).toBe('.afk/experience-context.md');
      expect(await fs.readFile(join(root, prepared!.path), 'utf8')).toContain(record.id);
      expect(await plugins.dispatchSystemAction('learning.context', { scope: record.scope })).toEqual(context);
      expect(await plugins.dispatchSystemAction('learning.context', { scope: 'github:other/wiki' })).toEqual({});
      const reader = new ExperienceStore({ file });
      try {
        expect(reader.recall({ scope: record.scope, prompt: 'sqlite retry' })).toEqual([]);
      } finally { reader.close(); }
      await expect(plugins.dispatchSystemAction('learning.context', { scope: record.scope, target: context.target })).rejects.toThrow();
    } finally { await plugins.dispose(); }
  });

  it.each(['applicability', 'target'] as const)('does not promote inherited %s through the experience provider', async field => {
    const { file, store } = await fixture();
    try {
      const record = store.recordFailure(failure());
      const context = { applicability: { environment: 'ci' },
        target: { project: record.scope, productVersions: { sqlite: '3.45' } } };
      store.verify(record.id, { runId: 'qa-own-properties', evidence: ['run:qa-own-properties#regression'] }, context);
      const query = { scope: record.scope, prompt: 'sqlite retry', ...context };
      const provider = new ExperienceContextProvider(file);
      expect(await provider.gather(query)).toHaveLength(1);
      const inherited = Object.assign(Object.create({ [field]: context[field] }), query);
      delete inherited[field];
      expect(await provider.gather(inherited)).toEqual([]);
    } finally { store.close(); }
  });

  it.each(['applicability', 'target'] as const)('rejects inherited %s before resolving execution context', async field => {
    const { root, store } = await fixture();
    store.close();
    const context = { applicability: { environment: 'ci' }, target: { project: 'github:acme/wiki' } };
    const input = Object.assign(Object.create({ [field]: context[field] }),
      { workItemId: 'github:acme/wiki#42', worktreePath: root, ...context });
    delete input[field];
    await expect(resolveExperienceQueryContext(input)).rejects.toThrow(/own properties/i);
  });

  it('uses actual clean Git revision and trusted configuration without interpreting prompt versions', async () => {
    const { root, store } = await fixture();
    store.close();
    const checkout = join(root, 'checkout');
    await fs.mkdir(checkout);
    const git = simpleGit(checkout);
    await git.init();
    await git.addConfig('user.name', 'T07');
    await git.addConfig('user.email', 't07@example.test');
    await fs.writeFile(join(checkout, 'source.txt'), 'source');
    await git.add('.');
    await git.commit('fixture');
    const context = await resolveExperienceQueryContext({ workItemId: 'github:acme/wiki#42', worktreePath: checkout,
      applicability: { version: 'knowledge-v2', environment: 'ci' },
      target: { project: 'github:acme/wiki', revision: 'f'.repeat(40), runtimeVersions: { node: '22.16' } } });
    expect(context).toMatchObject({ applicability: { version: 'knowledge-v2', environment: 'ci' },
      target: { project: 'github:acme/wiki', revision: await git.revparse('HEAD'), dirty: false, runtimeVersions: { node: '22.16' } } });
    await fs.writeFile(join(checkout, 'source.txt'), 'modified');
    expect((await resolveExperienceQueryContext({ workItemId: 'github:acme/wiki#42', worktreePath: checkout })).target?.dirty).toBe(true);
    await expect(resolveExperienceQueryContext({ workItemId: 'github:acme/wiki#42', worktreePath: checkout,
      target: { project: 'github:other/payments' } })).rejects.toThrow('project');
    const missing = await resolveExperienceQueryContext({ workItemId: 'github:acme/wiki#42', worktreePath: root });
    expect(missing.target?.revision).toBeUndefined();
    expect(missing.target?.runtimeVersions).toBeUndefined();
  });

  it('requires an intact independent QA cycle, trusted target snapshot and exact QA revision before persisting constraints', async () => {
    const { root, file, store } = await fixture();
    const record = store.recordFailure(failure());
    const context = { applicability: { environment: 'ci' }, target: { project: record.scope,
      revision: 'a'.repeat(40), dirty: false, productVersions: { sqlite: '3.45' } } };
    const snapshot: RunEventData = { kind: 'decision.made', command: 'experience.qa-target', accepted: true,
      reason: JSON.stringify({ ...context, target: { ...context.target, runtimeVersions: { node: '22.16' } } }) };
    const commit: RunEventData = { kind: 'commit.recorded', phase: 'qa', commitSha: context.target.revision, branch: 'qa' };
    const request = { root, file, scope: record.scope, id: record.id, runId: 'qa-proof', context, evidence: ['run:qa-proof#test'] };
    await recordRun(root, 'qa-proof', [{ kind: 'qa.started' }, snapshot, commit, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
    const verified = await verifyApplicableExperience(request);
    expect(store.recall({ scope: record.scope, prompt: 'sqlite', ...context }).map(entry => entry.id)).toEqual([verified.id]);
    const transferable = store.recordFailure({ ...failure(), trigger: 'transferable sqlite retry' });
    const requirements = { applicability: context.applicability, target: { project: record.scope, dirty: false, productVersions: { sqlite: '3.45' } } };
    await verifyApplicableExperience({ ...request, id: transferable.id, context: requirements });
    expect(store.recall({ scope: record.scope, prompt: 'transferable sqlite retry', ...requirements,
      target: { ...requirements.target, revision: 'b'.repeat(40) } }).map(entry => entry.id)).toEqual([transferable.id]);
    expect(store.recall({ scope: record.scope, prompt: 'sqlite', ...context,
      target: { ...context.target, revision: 'b'.repeat(40) } }).some(entry => entry.id === verified.id)).toBe(false);
    for (const [runId, events] of [
      ['missing', [{ kind: 'qa.started' }, commit, { kind: 'qa.passed' }]],
      ['stale', [{ kind: 'qa.started' }, snapshot, { kind: 'qa.started' }, commit, { kind: 'qa.passed' }]],
      ['wrong-revision', [{ kind: 'qa.started' }, snapshot, { ...commit, commitSha: 'b'.repeat(40) }, { kind: 'qa.passed' }]],
      ['late-snapshot', [{ kind: 'qa.started' }, commit, { kind: 'qa.passed' }, snapshot]],
      ['missing-revision', [{ kind: 'qa.started' }, { ...snapshot, reason: JSON.stringify({ ...context,
        target: { project: record.scope, dirty: false, productVersions: { sqlite: '3.45' } } }) }, commit, { kind: 'qa.passed' }]],
      ['dirty-revision', [{ kind: 'qa.started' }, { ...snapshot, reason: JSON.stringify({ ...context,
        target: { ...context.target, dirty: true } }) }, commit, { kind: 'qa.passed' }]],
    ] as [string, RunEventData[]][]) {
      await recordRun(root, runId, [...events, { kind: 'run.finished', outcome: 'succeeded' }]);
      await expect(verifyApplicableExperience({ ...request, runId, evidence: [`run:${runId}#test`] })).rejects.toThrow('target');
    }
    await expect(verifyApplicableExperience({ ...request, context: { ...context, target: { ...context.target, productVersions: { sqlite: '3.46' } } } })).rejects.toThrow('target');
    await recordRun(root, 'agent-asserted', [{ kind: 'qa.started' }, snapshot, commit, { kind: 'qa.passed' },
      { kind: 'run.finished', outcome: 'succeeded' }], 'github:acme/wiki#42', 'agent');
    await expect(verifyApplicableExperience({ ...request, runId: 'agent-asserted' })).rejects.toThrow('target');
    const history: RunEvent[] = [];
    for await (const event of new JsonlEventStore({ root }).read('qa-proof')) history.push(event);
    for (const kind of ['qa.started', 'commit.recorded', 'qa.passed', 'run.finished']) {
      const asserted = history.map(event => event.data.kind === kind
        ? { ...event, context: { ...event.context, actor: { kind: 'agent' as const, id: 'model' } } } : event);
      expect(successfulRunEvidenceFromEvents(request, asserted).qaTarget, kind).toBeUndefined();
    }
    store.close();
  });

  it('merges knowledge and experience using one trusted query and one bounded reference file', async () => {
    const { root, store } = await fixture();
    store.close();
    const plugins = new PluginRuntime();
    const experience = vi.fn(async (_query: import('../../plugin-sdk/capabilities.js').ContextQuery) => [{ origin: 'experience:verified', content: 'sqlite correction', score: 1 }]);
    const knowledge = vi.fn(async (_query: import('../../plugin-sdk/capabilities.js').ContextQuery) => Array.from({ length: 8 }, (_, index) => ({ origin: `knowledge:asset-${index}; qa:run:proof`, content: 'trusted material '.repeat(500), score: 1 })));
    await plugins.activate({ manifest: { id: 'test.context', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true },
      activate(context) {
        for (const [id, gather] of [['context.experience', experience], ['context.knowledge', knowledge]] as const)
          context.registerContextProvider(id, { id, capabilities: { 'read-only': true, summarize: false, search: true }, gather });
      } });
    try {
      const source = { runId: 'generic-context-run', workItemId: 'github:acme/wiki#99' };
      const request = { plugins, source, workItemId: source.workItemId, worktreePath: root, prompt: 'sqlite Node 99',
        applicability: { version: 'asset-2', environment: 'ci' }, target: { project: 'github:acme/wiki', productVersions: { sqlite: '3.45' } } };
      const prepared = await prepareExperienceContext(request);
      await prepared!.recordSelection();
      const reader = new ExperienceStore({ file: experienceStorePath(root) });
      try { expect(reader.contextReceipts({ scope: 'github:acme/wiki', source })).toEqual([]); }
      finally { reader.close(); }
      expect(experience.mock.calls[0][0]).toEqual(knowledge.mock.calls[0][0]);
      expect(knowledge.mock.calls[0][0]).toMatchObject({ scope: 'github:acme/wiki', applicability: request.applicability, target: request.target });
      const content = await fs.readFile(join(root, '.afk/experience-context.md'), 'utf8');
      expect(content).toContain('Source: experience:verified');
      expect(content).toContain('Source: knowledge:asset-0; qa:run:proof');
      expect(content.match(/\nSource:/g)?.length).toBeLessThanOrEqual(5);
      expect(content.length).toBeLessThanOrEqual(8000);
      await expect(prepareExperienceContext({ ...request, target: { project: 'github:foreign/wiki' } })).rejects.toThrow('project');
      expect(knowledge).toHaveBeenCalledTimes(1);
      await expect(fs.readFile(join(root, '.afk/experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await plugins.dispose(); }
  });

  it('records actual builtin retrievals separately from retained references and preserves them after reopening', async () => {
    const { root, file, store } = await fixture();
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const record = store.recordFailure({ ...failure(), trigger: `sqlite retry ${index}` });
      store.verify(record.id, { runId: `qa-${index}`, evidence: [`run:qa-${index}#regression`] });
      ids.push(record.id);
    }
    store.close();
    const plugins = new PluginRuntime();
    const provider = new ExperienceContextProvider(file);
    await plugins.activate({ manifest: { id: 'run-feedback-context', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true },
      activate(context) {
        context.registerContextProvider(provider.id, provider);
        context.registerContextProvider('context.knowledge', { id: 'context.knowledge', capabilities: provider.capabilities,
          async gather() { return Array.from({ length: 5 }, (_, index) => ({ origin: `knowledge:${index}`, content: 'independent reference' })); } });
      } });
    const source = { runId: 'context-consumer', workItemId: 'github:acme/wiki#99' };
    const receipts = () => {
      const reader = new ExperienceStore({ file });
      try { return reader.contextReceipts({ scope: 'github:acme/wiki', source }); } finally { reader.close(); }
    };
    try {
      await provider.gather({ scope: 'github:acme/wiki', prompt: 'sqlite retry' });
      expect(receipts()).toEqual([]);
      const prepared = await prepareExperienceContext({ source, workItemId: source.workItemId, plugins, worktreePath: root, prompt: 'sqlite retry' });
      const before = receipts();
      expect(before).toHaveLength(5);
      expect(before.every(receipt => receipt.stage === 'retrieved')).toBe(true);
      expect(before.map(receipt => receipt.experienceId).sort()).toEqual(ids.sort());
      const written = await fs.readFile(join(root, prepared!.path), 'utf8');
      expect(written.match(/\nSource:/g)).toHaveLength(5);
      await prepared!.recordSelection();
      const after = receipts();
      const selected = after.filter(receipt => receipt.stage === 'selected');
      expect(selected).toHaveLength(3);
      for (const receipt of selected) {
        expect(written).toContain(`experience:${receipt.experienceId};`);
        expect(receipt).toMatchObject({ source, verificationDigest: before.find(parent => parent.selectionId === receipt.selectionId)!.verificationDigest });
      }
      await prepared!.recordSelection();
      expect(receipts()).toEqual(after);
      const reader = new ExperienceStore({ file });
      try { expect(reader.metrics({ scope: 'github:acme/wiki' }).adoptions).toBe(0); } finally { reader.close(); }
    } finally { await plugins.dispose(); }
  });

  it('binds selection to the retained fragment and refuses feedback after the reference file changes', async () => {
    const { root, file, store } = await fixture();
    const record = store.recordFailure({ ...failure(), action: 'validated sqlite correction '.repeat(100) });
    store.verify(record.id, { runId: 'qa-long', evidence: ['run:qa-long#regression'] });
    store.close();
    const plugins = new PluginRuntime();
    const provider = new ExperienceContextProvider(file);
    await plugins.activate({ manifest: { id: 'bounded-feedback-context', version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true },
      activate(context) {
        context.registerContextProvider(provider.id, provider);
        context.registerContextProvider('context.knowledge', { id: 'context.knowledge', capabilities: provider.capabilities,
          async gather() { return Array.from({ length: 5 }, (_, index) => ({ origin: `knowledge:${index}`, content: 'reference '.repeat(500) })); } });
      } });
    const source = { runId: 'bounded-consumer', workItemId: 'github:acme/wiki#99' };
    try {
      const prepared = await prepareExperienceContext({ source, workItemId: source.workItemId, plugins, worktreePath: root, prompt: 'sqlite retry' });
      const written = await fs.readFile(join(root, prepared!.path), 'utf8');
      const section = written.split(/\nSource: /).find(part => part.startsWith(`experience:${record.id};`))!;
      const content = section.slice(section.indexOf('\n\n') + 2, -1);
      await prepared!.recordSelection();
      const reader = new ExperienceStore({ file });
      try {
        const selected = reader.contextReceipts({ scope: record.scope, source }).find(receipt => receipt.stage === 'selected')!;
        expect(selected.fragmentDigest).toBe(createHash('sha256').update(content).digest('hex'));
        expect(selected.fragmentDigest).not.toBe(selected.retrievedFragmentDigest);
      } finally { reader.close(); }
      const other = { ...source, runId: 'changed-file-consumer' };
      const changed = await prepareExperienceContext({ source: other, workItemId: other.workItemId, plugins, worktreePath: root, prompt: 'sqlite retry' });
      await fs.appendFile(join(root, changed!.path), '\nchanged reference');
      await expect(changed!.recordSelection()).rejects.toThrow('selection feedback is incomplete');
      const cold = new ExperienceStore({ file });
      try { expect(cold.contextReceipts({ scope: record.scope, source: other }).map(receipt => receipt.stage)).toEqual(['retrieved']); }
      finally { cold.close(); }
    } finally { await plugins.dispose(); }
  });

  it('refuses to bind an already-rendered fragment to a concurrently reverified experience', async () => {
    const { root, file, store } = await fixture();
    const record = store.recordFailure(failure());
    store.verify(record.id, { runId: 'qa-original', evidence: ['run:qa-original#regression'] });
    store.close();
    const plugins = new PluginRuntime();
    const provider = new ExperienceContextProvider(file);
    await plugins.activate({ manifest: { id: provider.id, version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true },
      activate(context) { context.registerContextProvider(provider.id, provider); } });
    const recordRetrieval = ExperienceStore.prototype.recordContextRetrieval;
    const race = vi.spyOn(ExperienceStore.prototype, 'recordContextRetrieval').mockImplementationOnce(function (this: ExperienceStore, input, actual) {
      const writer = new ExperienceStore({ file });
      try { writer.verify(record.id, { runId: 'qa-replacement', evidence: ['run:qa-replacement#regression'] }); }
      finally { writer.close(); }
      return recordRetrieval.call(this, input, actual);
    });
    const source = { runId: 'racing-consumer', workItemId: 'github:acme/wiki#99' };
    try {
      await expect(prepareExperienceContext({ source, workItemId: source.workItemId, plugins, worktreePath: root, prompt: 'sqlite retry' }))
        .rejects.toMatchObject({ name: 'ExperienceFeedbackError', cause: expect.objectContaining({ message: expect.stringMatching(/changed|snapshot|conflict/i) }) });
      await expect(fs.readFile(join(root, '.afk/experience-context.md'))).rejects.toMatchObject({ code: 'ENOENT' });
      const reader = new ExperienceStore({ file });
      try { expect(reader.contextReceipts({ scope: record.scope, source })).toEqual([]); }
      finally { reader.close(); }
    } finally { race.mockRestore(); await plugins.dispose(); }
  });

  it.each(['overwrite', 'symlink'] as const)('rejects a reference %s during preparation or selection without recording selection', async replacement => {
    const { root, file, store } = await fixture();
    const record = store.recordFailure(failure());
    store.verify(record.id, { runId: 'qa-reference', evidence: ['run:qa-reference#regression'] });
    store.close();
    const plugins = new PluginRuntime();
    const provider = new ExperienceContextProvider(file);
    await plugins.activate({ manifest: { id: provider.id, version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true },
      activate(context) { context.registerContextProvider(provider.id, provider); } });
    const source = { runId: `reference-${replacement}`, workItemId: 'github:acme/wiki#99' };
    const directory = join(await fs.realpath(root), '.afk');
    const target = join(directory, 'experience-context.md');
    const rename = fs.rename;
    const overwritten = replacement === 'overwrite' ? vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      await rename(from, to);
      await fs.writeFile(to, 'another preparation replaced this reference');
    }) : undefined;
    let swapped: { mockRestore(): void } | undefined;
    try {
      const prepared = await prepareExperienceContext({ source, workItemId: source.workItemId, plugins, worktreePath: root, prompt: 'sqlite retry' });
      if (replacement === 'symlink') {
        const outside = join(root, 'copied-reference.md');
        await fs.copyFile(target, outside);
        swapped = vi.spyOn(fs, 'realpath').mockImplementationOnce(async () => {
          await fs.unlink(target);
          await fs.symlink(outside, target);
          return directory;
        });
      }
      await expect(prepared!.recordSelection()).rejects.toThrow('selection feedback is incomplete');
      const reader = new ExperienceStore({ file });
      try { expect(reader.contextReceipts({ scope: record.scope, source }).map(receipt => receipt.stage)).toEqual(['retrieved']); }
      finally { reader.close(); }
    } finally { overwritten?.mockRestore(); swapped?.mockRestore(); await plugins.dispose(); }
  });

  it.each([
    { runId: 'foreign-run', workItemId: 'github:acme/wiki#98' },
    { runId: '', workItemId: 'github:acme/wiki#99' },
    { runId: ' padded-run ', workItemId: 'github:acme/wiki#99' },
    { runId: 'invalid\0run', workItemId: 'github:acme/wiki#99' },
    { runId: 'x'.repeat(513), workItemId: 'github:acme/wiki#99' },
  ])('rejects invalid feedback source %# before replacing a prepared reference', async source => {
    const { root, store } = await fixture();
    store.close();
    await fs.mkdir(join(root, '.afk'), { recursive: true });
    const target = join(root, '.afk', 'experience-context.md');
    await fs.writeFile(target, 'previous reference');
    await expect(prepareExperienceContext({ source,
      workItemId: 'github:acme/wiki#99', worktreePath: root, prompt: 'sqlite retry' })).rejects.toMatchObject({ name: 'ExperienceFeedbackError' });
    expect(await fs.readFile(target, 'utf8')).toBe('previous reference');
  });

  it('uses the same successful-run gate for frozen history and refuses learning-purpose or mismatched run evidence', async () => {
    const { root, store } = await fixture();
    try {
      await recordRun(root, 'proof', [{ kind: 'qa.started' }, { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }]);
      const history: RunEvent[] = [];
      for await (const event of new JsonlEventStore({ root }).read('proof')) history.push(event);
      const input = { scope: 'github:acme/wiki', runId: 'proof', workItemId: 'github:acme/wiki#42', evidence: [] };
      expect(successfulRunEvidenceFromEvents(input, history)).toMatchObject({ completionEvent: 'run.finished', evidence: ['run:proof#qa.passed'] });
      expect(() => successfulRunEvidenceFromEvents(input, history.map(event => ({ ...event, context: { ...event.context, purpose: 'learning' as const } })))).toThrow('Learning runs');
      expect(() => successfulRunEvidenceFromEvents({ ...input, runId: 'other' }, history)).toThrow('another run');
    } finally { store.close(); }
  });

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
      const context = await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId });
      return store.adopt({ id: record.id, scope: record.scope, source: { runId, workItemId } }, context);
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
    const adoption = await acknowledge('active');
    expect(adoption).toMatchObject({ retrievals: 0, adoptions: 1, recurrences: 0,
      receipt: { binding: 'verified-version', contextStatus: 'unavailable', experienceId: record.id, source: { runId: 'active', workItemId } } });
    expect(await acknowledge('active')).toEqual(adoption);
    store.close();
  });

  it.each(['snapshot and finish', 'qa.passed', 'qa.failed', 'run.finished'] as const)(
    'binds an active trusted target and rejects drift after agent %s without granting successful QA qualification', async claim => {
    const { root, file, store } = await fixture();
    let ledger = store;
    try {
      const record = store.recordFailure(failure());
      store.verify(record.id, { runId: 'qa-proof', evidence: ['run:qa-proof#qa.passed'] });
      const runId = 'active-target';
      const workItemId = `${record.scope}#99`;
      const actual = { target: { project: record.scope, revision: 'a'.repeat(40), dirty: false } };
      await recordRun(root, runId, [{ kind: 'qa.started' },
        { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(actual) }], workItemId);
      const context = await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId });
      expect(context).toEqual({ actual });
      const adoption = { id: record.id, scope: record.scope, source: { runId, workItemId } };
      const result = store.adopt(adoption, context);
      expect(result.receipt).toMatchObject({ contextStatus: 'recorded',
        contextDigest: createHash('sha256').update(canonicalLearningJson(actual)).digest('hex') });
      expect(store.adopt(adoption, await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId }))).toEqual(result);
      const claims: RunEventData[] = claim === 'snapshot and finish' ? [
        { kind: 'decision.made', command: 'experience.qa-target', accepted: true,
          reason: JSON.stringify({ target: { ...actual.target, revision: 'c'.repeat(40) } }) },
        { kind: 'run.finished', outcome: 'succeeded' },
      ] : [claim === 'run.finished' ? { kind: claim, outcome: 'succeeded' } : { kind: claim }];
      await new JsonlEventStore({ root }).append(claims.map((data, index) => ({ id: `active-target-agent-${index}`, schemaVersion: 1, type: data.kind,
        occurredAt: new Date().toISOString(), context: { traceId: runId, runId, workItemId, profileId: 'local', attempt: 1,
          actor: { kind: 'agent', id: 'claim' } }, correlationId: runId, data } as const)));
      expect(await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId })).toEqual({ actual });
      ledger.close();
      ledger = new ExperienceStore({ file });
      expect(ledger.adopt(adoption, await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId }))).toEqual(result);
      const changed = { target: { ...actual.target, revision: 'b'.repeat(40) } };
      await new JsonlEventStore({ root }).append([{ id: 'active-target-changed', schemaVersion: 1, type: 'decision.made',
        occurredAt: new Date().toISOString(), context: { traceId: runId, runId, workItemId, profileId: 'local', attempt: 1,
          actor: { kind: 'system', id: 'test' } }, correlationId: runId,
        data: { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(changed) } }]);
      const drifted = await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId });
      expect(drifted).toEqual({ actual: changed });
      expect(() => ledger.adopt(adoption, drifted)).toThrow('binding');
      ledger.close();
      ledger = new ExperienceStore({ file });
      expect(await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId })).toEqual(drifted);
      expect(() => ledger.adopt(adoption, drifted)).toThrow('binding');
      expect(ledger.metrics({ scope: record.scope }).adoptions).toBe(1);
    } finally { ledger.close(); }
  });

  it('keeps unknown-product adoption blocked after agent QA claims and reopening the persisted audit and store', async () => {
    const { root, file, store } = await fixture();
    let ledger = store;
    try {
      const record = ledger.recordFailure(failure());
      ledger.verify(record.id, { runId: 'qa-proof', evidence: ['run:qa-proof#qa.passed'] });
      const runId = 'unknown-product-agent-claims';
      const workItemId = `${record.scope}#99`;
      const actual = { target: { project: record.scope, revision: 'a'.repeat(40), dirty: false,
        productVersions: { sqlite: '3.45' } } };
      const input = { root, scope: record.scope, runId, workItemId };
      const adoption = { id: record.id, scope: record.scope, source: { runId, workItemId } };
      await recordRun(root, runId, [{ kind: 'qa.started' },
        { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(actual) },
        { kind: 'commit.recorded', phase: 'qa', commitSha: actual.target.revision, branch: 'qa' }], workItemId);
      const active = await verifyAdoptionRun(input);
      expect(active).toEqual({ actual });
      expect(() => ledger.adopt(adoption, active)).toThrow('applicability');
      await new JsonlEventStore({ root }).append(([
        { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' },
      ] satisfies RunEventData[]).map((data, index) => ({ id: `unknown-product-agent-${index}`, schemaVersion: 1, type: data.kind,
        occurredAt: new Date().toISOString(), context: { traceId: runId, runId, workItemId, profileId: 'local', attempt: 1,
          actor: { kind: 'agent', id: 'claim' } }, correlationId: runId, data } as const)));
      const claimed = await verifyAdoptionRun(input);
      expect(claimed).toEqual({ actual });
      expect(() => ledger.adopt(adoption, claimed)).toThrow('applicability');
      expect(ledger.metrics({ scope: record.scope }).adoptions).toBe(0);
      ledger.close();
      ledger = new ExperienceStore({ file });
      expect(await new JsonlEventStore({ root }).verify(runId)).toMatchObject({ valid: true, lastSequence: 5 });
      const replayed = await verifyAdoptionRun(input);
      expect(replayed).toEqual({ actual });
      expect(() => ledger.adopt(adoption, replayed)).toThrow('applicability');
      expect(ledger.metrics({ scope: record.scope }).adoptions).toBe(0);
    } finally { ledger.close(); }
  });

  it.each<{ name: string; completion: RunEventData; outcome?: 'failed' | 'cancelled'; qualified: boolean }>([
    { name: 'matching merge gate', completion: { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'review' }, qualified: true },
    { name: 'matching merged change', completion: { kind: 'change.merge_verified', changeId: '5', targetBranch: 'main' }, qualified: true },
    { name: 'wrong merge gate', completion: { kind: 'human_gate.opened', gateId: 'merge:6', reason: 'review' }, qualified: false },
    { name: 'wrong merged change', completion: { kind: 'change.merge_verified', changeId: '6', targetBranch: 'main' }, qualified: false },
    { name: 'failure after matching gate', completion: { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'review' }, outcome: 'failed', qualified: false },
    { name: 'cancellation after matching merge', completion: { kind: 'change.merge_verified', changeId: '5', targetBranch: 'main' }, outcome: 'cancelled', qualified: false },
  ])('separates persisted actual context from QA qualification for $name', async ({ completion, outcome, qualified }) => {
    const { root, store } = await fixture();
    store.close();
    const scope = 'github:acme/wiki';
    const workItemId = `${scope}#99`;
    const runId = 'published-target';
    const actual = { applicability: { environment: 'ci' }, target: { project: scope, revision: 'a'.repeat(40), dirty: false } };
    await recordRun(root, runId, [{ kind: 'qa.started' },
      { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(actual) },
      { kind: 'commit.recorded', phase: 'qa', commitSha: actual.target.revision, branch: 'qa' },
      { kind: 'qa.passed' }, { kind: 'change.published', changeId: '5', url: 'https://example.test/pull/5' },
      completion, ...(outcome ? [{ kind: 'run.finished' as const, outcome }] : [])], workItemId);
    const expected = qualified ? { actual, verified: actual } : { actual };
    expect(await verifyAdoptionRun({ root, scope, runId, workItemId })).toEqual(expected);
  });

  it.each<RunEventData>([
    { kind: 'human_gate.opened', gateId: 'merge:5', reason: 'review' },
    { kind: 'change.merge_verified', changeId: '5', targetBranch: 'main' },
    { kind: 'run.finished', outcome: 'succeeded' },
  ])('retains persisted actual without granting QA qualification from agent $kind', async completion => {
    const { root, store } = await fixture();
    store.close();
    const scope = 'github:acme/wiki';
    const workItemId = `${scope}#99`;
    const runId = 'agent-completion';
    const actual = { target: { project: scope, revision: 'a'.repeat(40), dirty: false } };
    await recordRun(root, runId, [{ kind: 'qa.started' },
      { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(actual) },
      { kind: 'commit.recorded', phase: 'qa', commitSha: actual.target.revision, branch: 'qa' },
      { kind: 'qa.passed' }, { kind: 'change.published', changeId: '5', url: 'https://example.test/pull/5' }], workItemId);
    await new JsonlEventStore({ root }).append([{ id: 'agent-completion-claim', schemaVersion: 1, type: completion.kind,
      occurredAt: new Date().toISOString(), context: { traceId: runId, runId, workItemId, profileId: 'local', attempt: 1,
        actor: { kind: 'agent', id: 'claim' } }, correlationId: runId, data: completion }]);
    expect(await verifyAdoptionRun({ root, scope, runId, workItemId })).toEqual({ actual });
  });

  it('adopts constrained lessons only with a trusted successful target from the exact task audit', async () => {
    const { root, store } = await fixture();
    try {
      const record = store.recordFailure(failure());
      const context = { applicability: { environment: 'ci' }, target: { project: record.scope,
        revision: 'a'.repeat(40), dirty: false, productVersions: { sqlite: '3.45' } } };
      store.verify(record.id, { runId: 'qa-original', evidence: ['run:qa-original#qa.passed'] }, context);
      const workItemId = `${record.scope}#99`;
      const history = (target = context, commit = context.target.revision): RunEventData[] => [
        { kind: 'qa.started' },
        { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(target) },
        { kind: 'commit.recorded', phase: 'qa', commitSha: commit, branch: 'qa-fixture' },
        { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' },
      ];
      const acknowledge = async (runId: string) => {
        const actual = await verifyAdoptionRun({ root, scope: record.scope, runId, workItemId });
        return store.adopt({ id: record.id, scope: record.scope, source: { runId, workItemId } }, actual);
      };
      await recordRun(root, 'active-constrained', [{ kind: 'run.started' }], workItemId);
      await expect(acknowledge('active-constrained')).rejects.toThrow('applicability');
      await recordRun(root, 'active-with-target', history().slice(0, 2), workItemId);
      await expect(acknowledge('active-with-target')).rejects.toThrow('applicability');
      await recordRun(root, 'agent-claim', history(), workItemId, 'agent');
      await expect(acknowledge('agent-claim')).rejects.toThrow('applicability');
      await recordRun(root, 'wrong-commit', history(context, 'b'.repeat(40)), workItemId);
      await expect(acknowledge('wrong-commit')).rejects.toThrow('applicability');
      await recordRun(root, 'wrong-environment', history({ ...context, applicability: { environment: 'production' } }), workItemId);
      await expect(acknowledge('wrong-environment')).rejects.toThrow('applicability');
      expect(store.metrics({ scope: record.scope }).adoptions).toBe(0);
      await recordRun(root, 'compatible', history(), workItemId);
      expect(await verifyAdoptionRun({ root, scope: record.scope, runId: 'compatible', workItemId })).toEqual({ actual: context, verified: context });
      expect((await acknowledge('compatible')).adoptions).toBe(1);
      expect((await acknowledge('compatible')).adoptions).toBe(1);
    } finally { store.close(); }
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
      const prepared = await prepareExperienceContext(request);
      const path = prepared?.path;
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
    expect(record).toBeDefined();
    if (!record) throw new Error('An unselected failure must create a candidate');
    expect(record.status).toBe('candidate');
    expect(record.scope).toBe('github:acme/wiki');
    expect(record.evidence).toEqual(['run:failed-runtime#failure.classified']);
    expect(JSON.stringify(record)).not.toContain('synthetic-secret');
    const fragments = await new ExperienceContextProvider(experienceStorePath(root)).gather({ scope: record.scope, prompt: 'sqlite' });
    expect(fragments).toEqual([]);
    await expect(new ExperienceContextProvider(experienceStorePath(root)).gather({ scope: record.scope, prompt: 'sqlite' }, { signal: AbortSignal.abort() })).rejects.toThrow();
  });
});
