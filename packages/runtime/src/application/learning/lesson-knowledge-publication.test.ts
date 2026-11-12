import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateStore } from './candidate-store.js';
import { page, wikiScript } from './knowledge.fixture.spec.js';
import { KnowledgeContextProvider, prepareConfiguredKnowledge, publishConfiguredKnowledge,
  reconcileConfiguredKnowledge, reconcileConfiguredLessons } from './knowledge-runtime.js';
import { createLessonPublicationFixture } from './lesson-publication.fixture.spec.js';
import { createLearningPlugin } from '../plugins/learning.js';
import { PluginRuntime } from '../plugins/runtime.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture() {
  const current = await createLessonPublicationFixture({ registerCleanup: cleanup => cleanups.push(cleanup),
    versions: ['fixture-v1'], includeFact: true });
  writeFileSync(join(current.vault, 'template.md'), page('{{title}}', '{{knowledge}}'));
  writeFileSync(join(current.vault, 'index.md'), page('Index', '[[backlinks]]'));
  writeFileSync(join(current.vault, 'backlinks.md'), page('Backlinks', '[[index]]'));
  const options = { file: current.file, recoveryDirectory: join(current.root, 'recovery'),
    validationConfigurationFile: current.configurationFile, config: { wikiScript, grants: [current.authorizationFile] } };
  const query = { scope: current.scope, prompt: 'duplicate retry', applicability: { version: 'fixture-v1' } };
  const target = join(current.vault, 'Retry.md');
  const provider = new KnowledgeContextProvider(options);
  const prepare = () => prepareConfiguredKnowledge({ ...options, scope: current.scope,
    candidateId: current.candidate.id, expectedVersion: current.candidate.version });
  const publish = (key: string) => publishConfiguredKnowledge({ ...options, scope: current.scope, key });
  return { ...current, options, query, target, context: provider, prepare, publish };
}

describe('validated lesson knowledge lifecycle', () => {
  it('publishes independently validated provenance and reuses only the matching version', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    expect(await current.publish(plan.key)).toMatchObject({ publication: { phase: 'committed' } });
    expect(current.store.getCandidate(current.candidate.id)).toMatchObject({ state: 'published', version: 3 });
    const content = readFileSync(current.target, 'utf8');
    expect(content).toContain('Serialize retry read and write');
    expect(content).toContain('independent-qa');
    expect(content).toContain(current.revision);
    const recalled = await current.context.gather(current.query);
    expect(recalled).toHaveLength(1);
    expect(recalled[0].content).toBe(content);
    expect(await current.context.gather({ ...current.query, applicability: { version: 'fixture-v2' } })).toEqual([]);
    expect(current.provider.verify).toHaveBeenCalledTimes(1);
  });

  it('blocks changed QA immediately and withdraws only that lesson with idempotent recovery', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    await current.publish(plan.key);
    const sibling = current.store.getCandidate(current.candidateIds[1])!;
    const navigation = ['index.md', 'backlinks.md'].map(path => readFileSync(join(current.vault, path), 'utf8'));
    await current.append('independent-qa', [{ kind: 'qa.failed', reason: 'Competing retry recurred' }]);
    expect(await current.context.gather(current.query)).toEqual([]);
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('published');
    const reconciled = await reconcileConfiguredKnowledge(current.options);
    expect(reconciled).toMatchObject({ blocked: [], results: [{ publication: { key: plan.key }, withdrawal: { status: 'withdrawn' } }] });
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('conflict');
    expect(current.store.getCandidate(sibling.id)).toEqual(sibling);
    expect(current.store.getRequest(current.source.key)?.blockedReason).toBeUndefined();
    expect(readFileSync(current.target, 'utf8')).toContain('knowledge_status: revoked');
    expect(['index.md', 'backlinks.md'].map(path => readFileSync(join(current.vault, path), 'utf8'))).toEqual(navigation);
    const withdrawn = readFileSync(current.target, 'utf8');
    expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ blocked: [] });
    expect(readFileSync(current.target, 'utf8')).toBe(withdrawn);
    expect(await current.context.gather(current.query)).toEqual([]);
  });

  it('invalidates unbound lessons without a knowledge configuration and preserves sibling facts', async () => {
    const current = await fixture();
    const sibling = current.store.getCandidate(current.candidateIds[1])!;
    await current.append('independent-qa', [{ kind: 'qa.failed', reason: 'Repair invalid' }]);
    const reconciled = await reconcileConfiguredLessons({ file: current.file,
      recoveryDirectory: current.options.recoveryDirectory, validationConfigurationFile: current.configurationFile });
    expect(reconciled).toEqual({ invalidated: [current.candidate.id] });
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('conflict');
    expect(current.store.getCandidate(sibling.id)).toEqual(sibling);
    expect(current.store.getRequest(current.source.key)?.blockedReason).toBeUndefined();
    expect(current.store.listPublications()).toEqual([]);
    expect(existsSync(current.target)).toBe(false);
  });

  it('refuses QA drift after preview before any knowledge is published', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    await current.append('independent-qa', [{ kind: 'qa.started' }]);
    expect(await current.publish(plan.key)).toMatchObject({ publication: { phase: 'conflict' }, withdrawal: { status: 'withdrawn' } });
    expect(existsSync(current.target)).toBe(false);
    expect(await current.context.gather(current.query)).toEqual([]);
  });

  it('reconciles through the registered plugin action when knowledge publication is unconfigured', async () => {
    const current = await fixture();
    current.store.close();
    const directory = join(current.root, '.afk', 'learning');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'candidates.sqlite');
    copyFileSync(current.file, file);
    const ledger = new CandidateStore({ file });
    cleanups.push(() => ledger.close());
    const sibling = ledger.getCandidate(current.candidateIds[1])!;
    const runtime = new PluginRuntime();
    try {
      await runtime.activate(createLearningPlugin({ homeDir: current.root, config: { enabled: true,
        validation: { configurationFile: current.configurationFile } } }));
      await current.append('independent-qa', [{ kind: 'qa.failed', reason: 'Retry fix regressed' }]);
      await runtime.dispatchSystemAction('learning.reconcile', { scope: current.scope,
        eventRoot: join(current.root, 'empty-events') });
      expect(ledger.getCandidate(current.candidate.id)?.state).toBe('conflict');
      expect(ledger.getCandidate(sibling.id)).toEqual(sibling);
      expect(ledger.getRequest(current.source.key)?.blockedReason).toBeUndefined();
      expect(ledger.listPublications()).toEqual([]);
    } finally { await runtime.close(); }
  });

  it('stops recall on checker permission removal and preserves human edits during withdrawal', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    await current.publish(plan.key);
    const manual = page('Manual retry policy', 'Human edit must survive withdrawal');
    writeFileSync(current.target, manual);
    current.configuration.checkers[0].allowLessonValidation = false;
    current.persistConfiguration();
    expect(await current.context.gather(current.query)).toEqual([]);
    expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ results: [
      { publication: { key: plan.key }, withdrawal: { status: 'rollback_blocked' } },
    ] });
    expect(readFileSync(current.target, 'utf8')).toBe(manual);
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('conflict');
  });

  it.each(['prepare', 'supersede'] as const)('rechecks lesson permission inside the %s database transaction', async operation => {
    const current = await fixture();
    let changed = false;
    const invalidate = () => {
      changed = true;
      current.configuration.checkers[0].allowLessonValidation = false;
      current.persistConfiguration();
    };
    if (operation === 'supersede') {
      await current.prepare();
      writeFileSync(join(current.vault, 'index.md'), page('Index', '[[backlinks]]\nNew navigation content'));
      const original = CandidateStore.prototype.supersedePreparedPublication;
      vi.spyOn(CandidateStore.prototype, 'supersedePreparedPublication').mockImplementation(function (this: CandidateStore, ...args) {
        invalidate();
        return original.apply(this, args);
      });
    } else {
      const original = CandidateStore.prototype.preparePublication;
      vi.spyOn(CandidateStore.prototype, 'preparePublication').mockImplementation(function (this: CandidateStore, ...args) {
        invalidate();
        return original.apply(this, args);
      });
    }
    await expect(current.prepare()).rejects.toThrow(/lesson_publication_/);
    expect(changed).toBe(true);
    expect(current.store.listPublications().every(publication => publication.phase === 'conflict')).toBe(true);
    expect(current.store.listPublications()).toHaveLength(operation === 'prepare' ? 0 : 1);
    expect(existsSync(current.target)).toBe(false);
    expect(await current.context.gather(current.query)).toEqual([]);
  });

  it.each(['applied', 'committed'] as const)('rechecks lesson permission inside the %s database advancement', async phase => {
    const current = await fixture();
    const plan = await current.prepare();
    const original = CandidateStore.prototype.advancePublication;
    let changed = false;
    vi.spyOn(CandidateStore.prototype, 'advancePublication').mockImplementation(function (this: CandidateStore, key, next, observed, guard) {
      if (!changed && next === phase && observed !== null) {
        changed = true;
        current.configuration.checkers[0].allowLessonValidation = false;
        current.persistConfiguration();
      }
      return original.call(this, key, next, observed, guard);
    });
    expect(await current.publish(plan.key)).toMatchObject({ publication: { phase: 'conflict' }, withdrawal: { status: 'withdrawn' } });
    expect(changed).toBe(true);
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('conflict');
    expect(readFileSync(current.target, 'utf8')).toContain('knowledge_status: revoked');
    expect(await current.context.gather(current.query)).toEqual([]);
  });

  it.each(['applied', 'committed'] as const)('preserves target edits made before the %s database advancement', async phase => {
    const current = await fixture();
    const plan = await current.prepare();
    const original = CandidateStore.prototype.advancePublication;
    const manual = page('Manual retry policy', 'Concurrent human edit must survive');
    let changed = false;
    vi.spyOn(CandidateStore.prototype, 'advancePublication').mockImplementation(function (this: CandidateStore, key, next, observed, guard) {
      if (!changed && next === phase && observed !== null) {
        changed = true;
        writeFileSync(current.target, manual);
      }
      return original.call(this, key, next, observed, guard);
    });
    expect(await current.publish(plan.key)).toMatchObject({ publication: { phase: 'conflict' }, withdrawal: { status: 'rollback_blocked' } });
    expect(changed).toBe(true);
    expect(readFileSync(current.target, 'utf8')).toBe(manual);
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('conflict');
    expect(await current.context.gather(current.query)).toEqual([]);
  });
});
