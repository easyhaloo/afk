import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateStore } from './candidate-store.js';
import { page, wikiScript } from './knowledge.fixture.spec.js';
import { KnowledgeContextProvider, prepareConfiguredKnowledge, publishConfiguredKnowledge,
  reconcileConfiguredKnowledge, reconcileConfiguredLessons } from './knowledge-runtime.js';
import { createLessonPublicationFixture } from './lesson-publication.fixture.spec.js';
import { readCurrentPublishedKnowledge, readPublishedKnowledge } from './publication.js';
import { createLearningPlugin } from '../plugins/learning.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { ExperienceStore, type ExperienceQueryContext } from './experience-store.js';
import * as publicationApi from './publication.js';
import { openSqlite } from '../../infrastructure/storage/sqlite.js';
import { readExperienceKnowledgeConfiguration } from './experience-configuration.js';
import { canonicalLearningJson } from './requests.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(options?: Pick<Parameters<typeof createLessonPublicationFixture>[0], 'versions' | 'applicability' | 'homeStorage' | 'triggerAliases'>) {
  const current = await createLessonPublicationFixture({ registerCleanup: cleanup => cleanups.push(cleanup),
    versions: ['fixture-v1'], includeFact: true, ...options });
  writeFileSync(join(current.vault, 'template.md'), page('{{title}}', '{{knowledge}}'));
  writeFileSync(join(current.vault, 'index.md'), page('Index', '[[backlinks]]'));
  writeFileSync(join(current.vault, 'backlinks.md'), page('Backlinks', '[[index]]'));
  const runtimeOptions = { file: current.file, recoveryDirectory: options?.homeStorage ? join(current.root, '.afk', 'learning', 'publications') : join(current.root, 'recovery'),
    validationConfigurationFile: current.configurationFile, config: { wikiScript, grants: [current.authorizationFile] } };
  const query = { scope: current.scope, prompt: 'duplicate retry', applicability: { version: 'fixture-v1' } };
  const target = join(current.vault, 'Retry.md');
  const provider = new KnowledgeContextProvider(runtimeOptions);
  const prepare = () => prepareConfiguredKnowledge({ ...runtimeOptions, scope: current.scope,
    candidateId: current.candidate.id, expectedVersion: current.candidate.version });
  const publish = (key: string) => publishConfiguredKnowledge({ ...runtimeOptions, scope: current.scope, key });
  return { ...current, options: runtimeOptions, query, target, context: provider, prepare, publish };
}

describe('validated lesson knowledge lifecycle', () => {
  it('enforces the saved source grant for both plugin recall and an already projected lesson', async () => {
    const current = await fixture({ homeStorage: true, triggerAliases: ['double enqueue'] });
    const plan = await current.prepare();
    await current.publish(plan.key);
    const sourceReadGrantFile = join(current.root, 'source-read.json');
    const paths = [current.sourceInput.path, current.oracle, current.qaPath];
    const save = (revoked: boolean, permitted = paths) => writeFileSync(sourceReadGrantFile, JSON.stringify({ version: 1, grants: [{
      scope: current.scope, targetRef: plan.targetRef, evidenceDigest: plan.evidenceDigest, paths: permitted, revoked,
    }] }), { mode: 0o600 });
    save(false);
    const config = { enabled: false, knowledge: { ...current.options.config, sourceReadGrantFile },
      validation: { configurationFile: current.configurationFile } };
    writeFileSync(join(current.root, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'learning.distiller', builtin: true, config }] }));
    const runtime = new PluginRuntime();
    const experience = new ExperienceStore({ file: join(dirname(current.file), 'experience.sqlite'), homeDir: current.root });
    try {
      await runtime.activate(createLearningPlugin({ homeDir: current.root, config }));
      const provider = runtime.getContextProvider('context.knowledge')!;
      expect(await provider.gather(current.query)).toHaveLength(1);
      const records = experience.recall(current.query);
      expect(records).toHaveLength(1);
      const alias = { ...current.query, prompt: 'Investigate DOUBLE enqueue on startup' };
      expect(experience.recall(alias)).toEqual(records);
      for (const prompt of ['enqueue', 'double unrelated enqueue', 'double 故障 enqueue', 'doubled enqueue', 'double, enqueue',
        'no double enqueue', 'double enqueue is absent', 'duplicate retry; exclude double enqueue']) {
        expect(experience.recall({ ...alias, prompt })).toEqual([]);
      }
      expect(experience.recall({ ...alias, scope: 'github:other/project' })).toEqual([]);
      save(true);
      expect(experience.recall(alias)).toEqual([]);
      expect(await provider.gather(current.query)).toEqual([]);
      expect(experience.recall(current.query)).toEqual([]);
      save(false, paths.filter(path => path !== current.qaPath));
      expect(experience.recall(alias)).toEqual([]);
      expect(experience.recall(current.query)).toEqual([]);
      save(false);
      expect(experience.recall(current.query)).toEqual(records);
    } finally { experience.close(); await runtime.close(); }
  });

  it('checks the current trusted home before direct consumption and old receipt replay, including after reopening', async () => {
    const current = await fixture({ homeStorage: true });
    const plan = await current.prepare();
    await current.publish(plan.key);
    const plugin = { id: 'learning.distiller', builtin: true, config: { enabled: false,
      knowledge: current.options.config, validation: { configurationFile: current.configurationFile } } };
    const configuration = join(current.root, '.afk', 'plugins.yml');
    writeFileSync(configuration, JSON.stringify({ plugins: [plugin] }));
    expect(readExperienceKnowledgeConfiguration(current.root)).toEqual({ ...current.options, homeDir: current.root });
    const file = join(dirname(current.file), 'experience.sqlite');
    const experience = new ExperienceStore({ file, homeDir: current.root });
    cleanups.push(() => experience.close());
    const record = experience.recall(current.query)[0];
    expect(record).toBeDefined();
    const context = { applicability: current.query.applicability };
    const adoption = { id: record.id, scope: current.scope, source: { runId: 'consumer', workItemId: `${current.scope}#20` } };
    const receipt = experience.adopt(adoption, { actual: context, verified: context });
    const metrics = experience.metrics({ scope: current.scope });
    const otherHome = join(current.root, 'other-home');
    mkdirSync(otherHome);
    for (const homeDir of [otherHome, current.root]) {
      if (homeDir === current.root) writeFileSync(configuration, JSON.stringify({ plugins: [{ ...plugin, enabled: false }] }));
      if (homeDir === current.root) expect(experience.recall(current.query)).toEqual([]);
      const isolated = new ExperienceStore({ file, homeDir });
      cleanups.push(() => isolated.close());
      expect(isolated.recall(current.query)).toEqual([]);
      expect(() => isolated.adopt(adoption, { actual: context, verified: context })).toThrow('matching verified applicability');
      expect(isolated.metrics({ scope: current.scope })).toEqual(metrics);
      isolated.close();
      const reopened = new ExperienceStore({ file, homeDir });
      cleanups.push(() => reopened.close());
      expect(reopened.recall(current.query)).toEqual([]);
      expect(() => reopened.adopt(adoption, { actual: context, verified: context })).toThrow('matching verified applicability');
      expect(reopened.metrics({ scope: current.scope })).toEqual(metrics);
    }
    expect(() => experience.adopt(adoption, { actual: context, verified: context })).toThrow('matching verified applicability');
    writeFileSync(configuration, JSON.stringify({ plugins: [plugin] }));
    expect(experience.adopt(adoption, { actual: context, verified: context })).toMatchObject({ adoptions: receipt.adoptions, receipt: receipt.receipt });
    expect(experience.metrics({ scope: current.scope })).toEqual(metrics);
  });

  it('preserves multiple allowed versions and environments and requires every positive and negative condition', async () => {
    const current = await fixture({ versions: ['fixture-v1', 'fixture-v2'], applicability: {
      environments: ['local', 'staging'], preconditions: ['retryEnabled'], exclusions: ['maintenance'], invalidationConditions: ['raceReturned'] } });
    const plan = await current.prepare();
    await current.publish(plan.key);
    const experience = new ExperienceStore({ file: join(dirname(current.file), 'experience.sqlite'), knowledge: current.options });
    cleanups.push(() => experience.close());
    const query = { ...current.query, applicability: { version: 'fixture-v2', environment: 'staging' },
      target: { project: current.scope, conditions: { retryEnabled: true, maintenance: false, raceReturned: false } } };
    expect(experience.recall(query)).toHaveLength(1);
    const record = experience.recall(query)[0];
    const adoption = { id: record.id, scope: current.scope, source: { runId: 'consumer', workItemId: `${current.scope}#20` } };
    const context = { applicability: query.applicability, target: query.target };
    const receipt = experience.adopt(adoption, { actual: context, verified: context });
    expect(experience.recall({ ...query, applicability: { version: 'fixture-v1', environment: 'local' } })).toHaveLength(1);
    const metrics = experience.metrics({ scope: current.scope });
    expect(experience.recall({ ...query, applicability: { version: 'fixture-v3', environment: 'staging' } })).toEqual([]);
    expect(experience.recall({ ...query, applicability: { version: 'fixture-v1' } })).toEqual([]);
    expect(experience.recall({ ...query, applicability: { environment: 'local' } })).toEqual([]);
    for (const condition of ['retryEnabled', 'maintenance', 'raceReturned'] as const) {
      const conditions = { ...query.target.conditions, [condition]: !query.target.conditions[condition] };
      expect(experience.recall({ ...query, target: { project: current.scope, conditions } })).toEqual([]);
      const changed = { ...context, target: { project: current.scope, conditions } };
      expect(() => experience.adopt(adoption, { actual: changed, verified: changed })).toThrow('matching verified applicability');
      const missing: Partial<typeof conditions> = { ...query.target.conditions };
      delete missing[condition];
      expect(experience.recall({ ...query, target: { project: current.scope, conditions: missing as Record<string, boolean> } })).toEqual([]);
    }
    expect(experience.recall({ ...query, target: { ...query.target, project: 'github:acme/other' } })).toEqual([]);
    expect(experience.metrics({ scope: current.scope })).toEqual(metrics);
    expect(experience.adopt(adoption, { actual: context, verified: context })).toMatchObject({ adoptions: receipt.adoptions, receipt: receipt.receipt });
  });

  it('projects the committed successor after shared navigation supersedes the prepared publication', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    const index = join(current.vault, 'index.md');
    writeFileSync(index, readFileSync(index, 'utf8') + '\nHuman navigation addition.\n');
    const result = await current.publish(plan.key);
    expect(result.publication.phase).toBe('committed');
    expect(result.publication.key).not.toBe(plan.key);
    expect(result.experienceProjection.blocked).toEqual([]);
    expect(current.store.getPublication(plan.key)).toMatchObject({ phase: 'superseded', supersededBy: result.publication.key });
    const file = join(dirname(current.file), 'experience.sqlite');
    const experience = new ExperienceStore({ file, knowledge: current.options });
    cleanups.push(() => experience.close());
    const [record] = experience.recall(current.query);
    const publication = { key: result.publication.key, candidateId: current.candidate.id,
      validatedVersion: current.receipt.validatedVersion, candidateDigest: current.candidate.digest,
      evidenceDigest: current.candidate.evidenceDigest, validatorVersion: current.receipt.validatorVersion,
      targetRef: result.publication.targetRef };
    expect(record.publication).toEqual(publication);
    const source = { runId: 'successor-consumer', workItemId: `${current.scope}#20` };
    const adoption = { id: record.id, scope: current.scope, source };
    const context = { applicability: current.query.applicability };
    const receipt = experience.adopt(adoption, { actual: context, verified: context });
    expect(receipt).toMatchObject({ adoptions: 1, receipt: { version: 2, source, publication } });
    const database = openSqlite({ file, schema: '', version: 3 });
    cleanups.push(() => database.close());
    const row = database.prepare("SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id)!;
    const binding = JSON.parse(String(row.evidence_hash));
    expect(binding).toEqual({ version: 2, source, publication, verificationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      contextDigest: expect.stringMatching(/^[a-f0-9]{64}$/), acknowledgedAt: expect.any(String) });
    const metrics = experience.metrics({ scope: current.scope });
    const { publication: _publication, ...withoutPublication } = binding;
    const changedBindings = [withoutPublication, { ...binding, publication: { ...publication, foreign: true } },
      ...Object.entries({ key: plan.key, candidateId: '0'.repeat(64), validatedVersion: publication.validatedVersion + 1,
        candidateDigest: '0'.repeat(64), evidenceDigest: '0'.repeat(64), validatorVersion: 'foreign', targetRef: 'wiki:foreign' })
        .map(([key, value]) => ({ ...binding, publication: { ...publication, [key]: value } })),
      ...Object.keys(publication).map(key => ({ ...binding, publication: Object.fromEntries(Object.entries(publication).filter(([field]) => field !== key)) }))];
    for (const changed of changedBindings) {
      database.prepare("UPDATE experience_receipts SET evidence_hash = ? WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'")
        .run(JSON.stringify(changed), record.id);
      expect(() => experience.adopt(adoption, { actual: context, verified: context })).toThrow(/binding/i);
      expect(experience.metrics({ scope: current.scope })).toEqual(metrics);
    }
    database.prepare("UPDATE experience_receipts SET evidence_hash = ? WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'")
      .run(row.evidence_hash, record.id);
    expect((await current.publish(plan.key)).publication.key).toBe(result.publication.key);
    expect(experience.list({ scope: current.scope })).toHaveLength(1);
    experience.close();
    const reopened = new ExperienceStore({ file, knowledge: current.options });
    cleanups.push(() => reopened.close());
    expect(reopened.adopt(adoption, { actual: context, verified: context })).toEqual(receipt);
    expect(reopened.metrics({ scope: current.scope })).toEqual(metrics);
    expect(database.prepare("SELECT evidence_hash FROM experience_receipts WHERE experience_id = ? AND source_hash LIKE 'metric:adoption:%'").get(record.id)).toEqual(row);
  });

  it('preserves cancellation after publication commit and repairs the missing projection', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    const controller = new AbortController();
    const reason = new Error('Stop before experience projection');
    const publish = publicationApi.publishLearningCandidate;
    vi.spyOn(publicationApi, 'publishLearningCandidate').mockImplementation(async input => {
      const result = await publish(input);
      controller.abort(reason);
      return result;
    });
    await expect(publishConfiguredKnowledge({ ...current.options, scope: current.scope, key: plan.key,
      signal: controller.signal })).rejects.toBe(reason);
    expect(current.store.getPublication(plan.key)?.phase).toBe('committed');
    const file = join(dirname(current.file), 'experience.sqlite');
    expect(existsSync(file)).toBe(false);
    expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ blocked: [] });
    const experience = new ExperienceStore({ file, knowledge: current.options });
    cleanups.push(() => experience.close());
    expect(experience.recall(current.query)).toHaveLength(1);
  });

  it('rolls back projection and eviction together and retries without duplicates', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    const file = join(dirname(current.file), 'experience.sqlite');
    const experience = new ExperienceStore({ file, knowledge: current.options });
    cleanups.push(() => experience.close());
    for (let index = 0; index < 1000; index++) experience.recordFailure({ scope: current.scope, trigger: `failure-${index}`,
      rootCause: 'race', action: 'serialize', evidence: ['run:failure'], source: { runId: `failure-${index}`, workItemId: current.workItemId } });
    const database = openSqlite({ file, schema: '', version: 3 });
    cleanups.push(() => database.close());
    const before = database.prepare('SELECT * FROM experiences ORDER BY id').all();
    database.exec(`CREATE TRIGGER reject_projection_eviction AFTER DELETE ON experiences
      BEGIN SELECT RAISE(ABORT, 'projection eviction failure'); END;`);
    expect(await current.publish(plan.key)).toMatchObject({ publication: { phase: 'committed' }, experienceProjection: { blocked: [plan.key] } });
    expect(database.prepare('SELECT * FROM experiences ORDER BY id').all()).toEqual(before);
    expect(experience.list({ scope: current.scope, status: 'verified' })).toEqual([]);
    database.exec('DROP TRIGGER reject_projection_eviction');
    experience.projectPublishedLesson({ scope: current.scope, key: plan.key });
    expect(experience.recall(current.query)).toHaveLength(1);
    expect(database.prepare('SELECT COUNT(*) AS count FROM experiences').get()?.count).toBe(1000);
    experience.projectPublishedLesson({ scope: current.scope, key: plan.key });
    expect(experience.list({ scope: current.scope, status: 'verified' })).toHaveLength(1);
  });

  it('retains a committed publication receipt when experience storage fails and repairs it later', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    const file = join(dirname(current.file), 'experience.sqlite');
    mkdirSync(file);
    expect(await current.publish(plan.key)).toMatchObject({ publication: { phase: 'committed' }, experienceProjection: { blocked: [plan.key] } });
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('published');
    expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ blocked: [{ key: plan.key, code: 'experience_projection_blocked' }] });
    rmSync(file, { recursive: true });
    expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ blocked: [] });
    const experience = new ExperienceStore({ file, knowledge: current.options });
    cleanups.push(() => experience.close());
    expect(experience.recall(current.query)).toHaveLength(1);
  });

  it.each(['publish', 'reconcile'] as const)('preserves committed %s results when projection cannot reread the candidate ledger', async operation => {
    const current = await fixture();
    const plan = await current.prepare();
    const file = join(dirname(current.file), 'experience.sqlite');
    if (operation === 'reconcile') {
      await current.publish(plan.key);
      const projected = new ExperienceStore({ file, knowledge: current.options });
      try { expect(projected.recall(current.query)).toMatchObject([{ publication: { key: plan.key } }]); }
      finally { projected.close(); }
      rmSync(file);
    }
    expect(existsSync(file)).toBe(false);
    let unavailable = false;
    let failures = 0;
    const readPublication = CandidateStore.prototype.getPublication;
    vi.spyOn(CandidateStore.prototype, 'getPublication').mockImplementation(function (this: CandidateStore, key) {
      if (unavailable) { failures++; throw new Error('Candidate ledger unavailable during projection'); }
      return readPublication.call(this, key);
    });
    if (operation === 'publish') {
      const publish = publicationApi.publishLearningCandidate;
      vi.spyOn(publicationApi, 'publishLearningCandidate').mockImplementation(async input => {
        const result = await publish(input);
        unavailable = true;
        return result;
      });
      expect(await current.publish(plan.key)).toMatchObject({ publication: { key: plan.key, phase: 'committed' },
        experienceProjection: { blocked: [plan.key] } });
    } else {
      const reconcile = publicationApi.reconcileKnowledgePublications;
      vi.spyOn(publicationApi, 'reconcileKnowledgePublications').mockImplementation(async input => {
        const result = await reconcile(input);
        unavailable = true;
        return result;
      });
      expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ results: [{ publication: { key: plan.key, phase: 'committed' } }],
        blocked: [{ key: plan.key, code: 'experience_projection_blocked' }] });
    }
    expect(failures).toBe(1);
    expect(existsSync(file)).toBe(false);
    unavailable = false;
    vi.restoreAllMocks();
    const publication = current.store.getPublication(plan.key);
    expect(publication?.phase).toBe('committed');
    const experience = new ExperienceStore({ file, knowledge: current.options });
    cleanups.push(() => experience.close());
    expect(experience.recall(current.query)).toEqual([]);
    expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ blocked: [] });
    expect(experience.recall(current.query)).toMatchObject([{ status: 'verified', publication: { key: plan.key,
      candidateId: current.candidate.id, validatedVersion: 2, candidateDigest: current.candidate.digest } }]);
    expect(current.store.getPublication(plan.key)).toEqual(publication);
    expect(await current.context.gather(current.query)).toHaveLength(1);
  });

  it.each([['publish', false], ['reconcile', false], ['publish', true], ['reconcile', true]] as const)(
    'preserves committed %s results and cancellation=%s when the projection store close throws', async (operation, cancelled) => {
      const current = await fixture();
      const plan = await current.prepare();
      const file = join(dirname(current.file), 'experience.sqlite');
      if (operation === 'reconcile') {
        await current.publish(plan.key);
        rmSync(file);
      }
      expect(existsSync(file)).toBe(false);
      const controller = new AbortController();
      const reason = new Error('Stop after experience projection commit');
      const closeFailure = new Error('Experience projection close failed');
      let closeFailures = 0;
      const project = ExperienceStore.prototype.projectPublishedLesson;
      vi.spyOn(ExperienceStore.prototype, 'projectPublishedLesson').mockImplementation(function (this: ExperienceStore, input) {
        const close = this.close;
        vi.spyOn(this, 'close').mockImplementationOnce(() => {
          close.call(this);
          closeFailures++;
          throw closeFailure;
        });
        const record = project.call(this, input);
        if (cancelled) { controller.abort(reason); throw reason; }
        return record;
      });
      const input = { ...current.options, signal: controller.signal };
      const result = operation === 'publish'
        ? publishConfiguredKnowledge({ ...input, scope: current.scope, key: plan.key })
        : reconcileConfiguredKnowledge(input);
      if (cancelled) await expect(result).rejects.toBe(reason);
      else await expect(result).resolves.toMatchObject(operation === 'publish'
        ? { publication: { key: plan.key, phase: 'committed' }, experienceProjection: { blocked: [plan.key] } }
        : { results: [{ publication: { key: plan.key, phase: 'committed' } }], blocked: [{ key: plan.key, code: 'experience_projection_blocked' }] });
      expect(closeFailures).toBe(1);
      vi.restoreAllMocks();
      const publication = current.store.getPublication(plan.key);
      expect(publication).toMatchObject({ key: plan.key, phase: 'committed' });
      const candidate = current.store.getCandidate(current.candidate.id);
      expect(candidate).toMatchObject({ state: 'published' });
      const experience = new ExperienceStore({ file, knowledge: current.options });
      cleanups.push(() => experience.close());
      const records = experience.recall(current.query);
      expect(records).toMatchObject([{ status: 'verified', publication: { key: plan.key, candidateId: current.candidate.id } }]);
      expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ blocked: [] });
      expect(experience.recall(current.query)).toEqual(records);
      expect(current.store.getPublication(plan.key)).toEqual(publication);
      expect(current.store.getCandidate(current.candidate.id)).toEqual(candidate);
    });

  it('matches the validated product and version independently of the prompt and scalar version', async () => {
    const current = await fixture({ applicability: { productId: 'parcel' }, versions: ['2.0', '2.1'] });
    const plan = await current.prepare();
    expect(await current.publish(plan.key)).toMatchObject({ experienceProjection: { blocked: [] } });
    const experience = new ExperienceStore({ file: join(dirname(current.file), 'experience.sqlite'), knowledge: current.options });
    cleanups.push(() => experience.close());
    const query = { scope: current.scope, prompt: 'parcel 2.0 duplicate retry' };
    const target = { project: current.scope, productVersions: { parcel: '2.0' } };
    for (const version of ['2.0', '2.1']) {
      const named = { ...query, target: { ...target, productVersions: { parcel: version } } };
      expect(experience.recall(named)).toMatchObject([{ publication: { key: plan.key } }]);
      expect(await current.context.gather(named)).toHaveLength(1);
    }
    const refused: ExperienceQueryContext[] = [{}, { applicability: { version: '2.0' } }, { target, applicability: { version: '2.1' } },
      { target: { ...target, productVersions: { other: '2.0' } } }, { target: { ...target, productVersions: { parcel: '1.0' } } },
      { target: { ...target, productVersions: { parcel: '2.0', other: '2.0' } } }, { target: { ...target, runtimeVersions: { node: '22' } } },
      { target: { ...target, productVersions: { parcel: '2.0', ['__proto__']: '2.0' } } },
      { target: { ...target, productVersions: { ' parcel': '2.0' } } }];
    for (const context of refused) {
      expect(experience.recall({ ...query, ...context })).toEqual([]);
      expect(await current.context.gather({ ...query, ...context })).toEqual([]);
    }
  });

  it('projects a published lesson once, preserves adoption receipts and refuses unbound exchange or verification', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    expect(await current.publish(plan.key)).toMatchObject({ publication: { phase: 'committed' }, experienceProjection: { blocked: [] } });
    const file = join(dirname(current.file), 'experience.sqlite');
    const experience = new ExperienceStore({ file, knowledge: current.options });
    cleanups.push(() => experience.close());
    const records = experience.recall(current.query);
    expect(records).toHaveLength(1);
    const record = records[0];
    expect(record).toMatchObject({ status: 'verified', publication: { key: plan.key,
      candidateId: current.candidate.id, validatedVersion: 2, candidateDigest: current.candidate.digest } });
    expect(experience.projectPublishedLesson({ scope: current.scope, key: plan.key })).toEqual(record);
    const context = { applicability: current.query.applicability, target: { project: current.scope, revision: 'b'.repeat(40), dirty: false } };
    const adoption = { id: record.id, scope: current.scope, source: { runId: 'consumer', workItemId: `${current.scope}#20` } };
    expect(() => experience.adopt(adoption, { actual: context })).toThrow('matching verified applicability');
    const receipt = experience.adopt(adoption, { actual: context, verified: context });
    expect(receipt.adoptions).toBe(1);
    expect(experience.adopt(adoption, { actual: context, verified: context })).toEqual(receipt);
    expect(experience.recall({ ...current.query, applicability: { version: 'fixture-v2' } })).toEqual([]);
    for (const versions of [{ productVersions: { sqlite: 'fixture-v1' } }, { runtimeVersions: { node: '22' } }]) {
      const query = { ...current.query, target: { project: current.scope, ...versions } };
      expect(experience.recall(query)).toEqual([]);
      expect(await current.context.gather(query)).toEqual([]);
    }
    expect(() => experience.verify(record.id, { runId: 'other-qa', evidence: ['run:other-qa#passed'] })).toThrow('independent candidate validation');
    expect(JSON.parse(experience.export({ scope: current.scope })).experiences).toEqual([]);
    expect(() => experience.copy({ id: record.id, scope: current.scope, targetScope: 'github:acme/other' })).toThrow('publication binding');
    await current.publish(plan.key);
    await reconcileConfiguredKnowledge(current.options);
    expect(experience.list({ scope: current.scope })).toHaveLength(1);
    expect(experience.adopt(adoption, { actual: context, verified: context })).toEqual(receipt);
    experience.close();
    const unconfigured = new ExperienceStore({ file });
    cleanups.push(() => unconfigured.close());
    expect(unconfigured.get(record.id, current.scope)).toBeDefined();
    expect(unconfigured.recall(current.query)).toEqual([]);
    expect(() => unconfigured.adopt(adoption, { actual: context, verified: context })).toThrow('matching verified applicability');
  });

  it.each(['grant', 'source'] as const)(
    'cold-replays independently seeded v1 published-lesson receipts unchanged and checks eligibility after %s invalidation', async change => {
      const current = await fixture();
      const plan = await current.prepare();
      await current.publish(plan.key);
      const file = join(dirname(current.file), 'experience.sqlite');
      const experience = new ExperienceStore({ file, knowledge: current.options });
      cleanups.push(() => experience.close());
      const [record] = experience.list({ scope: current.scope });
      expect(record).toMatchObject({ status: 'verified', publication: { key: plan.key } });
      experience.close();
      const context = { applicability: current.query.applicability };
      const source = { runId: 'historical-v1-consumer', workItemId: `${current.scope}#20` };
      const adoption = { id: record.id, scope: current.scope, source };
      const hash = (value: string) => createHash('sha256').update(value).digest('hex');
      const binding = { version: 1, verificationDigest: hash(canonicalLearningJson({ id: record.id, scope: record.scope,
        kind: record.kind ?? 'failure', trigger: record.trigger, rootCause: record.rootCause, action: record.action, expiresAt: record.expiresAt,
        verification: record.verifiedEvidence, publication: record.publication, applicability: {} })),
      contextDigest: hash(canonicalLearningJson(context)), acknowledgedAt: '2026-11-15T08:00:00.000Z' };
      const payload = JSON.stringify(binding, null, 2) + '\n';
      const counts = { retrievals: 0, adoptions: 1, recurrences: 0 };
      const rows = [{ experience_id: record.id, source_hash: `metric:adoption:${hash(JSON.stringify(source))}`,
        run_hash: hash(JSON.stringify(source.runId)), evidence_hash: payload },
      { experience_id: record.id, source_hash: 'metric:counts', run_hash: 'metric', evidence_hash: JSON.stringify(counts) }];
      const database = openSqlite({ file, schema: '', version: 3 });
      try {
        expect(database.prepare('SELECT * FROM experience_receipts WHERE experience_id = ?').all(record.id)).toEqual([]);
        for (const row of rows) database.prepare('INSERT INTO experience_receipts VALUES (?, ?, ?, ?)')
          .run(row.experience_id, row.source_hash, row.run_hash, row.evidence_hash);
      } finally { database.close(); }
      const readRows = () => {
        const reader = openSqlite({ file, schema: '', version: 3 });
        try { return reader.prepare('SELECT * FROM experience_receipts WHERE experience_id = ? ORDER BY source_hash').all(record.id); }
        finally { reader.close(); }
      };
      const reopened = new ExperienceStore({ file, knowledge: current.options });
      cleanups.push(() => reopened.close());
      const expected = { ...counts, receipt: { experienceId: record.id, scope: current.scope, source,
        binding: 'verified-version', contextStatus: 'recorded', ...binding } };
      expect(reopened.adopt(adoption, { actual: context, verified: context })).toEqual(expected);
      expect(reopened.adopt(adoption, { actual: context, verified: context })).toEqual(expected);
      expect(reopened.metrics({ scope: current.scope })).toEqual(counts);
      expect(readRows()).toEqual(rows);
      reopened.close();
      if (change === 'grant') { current.grant.revoked = true; current.persistGrant(); }
      else writeFileSync(current.sourceInput.path, 'changed source\n');
      const ineligible = new ExperienceStore({ file, knowledge: current.options });
      cleanups.push(() => ineligible.close());
      expect(() => ineligible.adopt(adoption, { actual: context, verified: context })).toThrow('matching verified applicability');
      expect(ineligible.metrics({ scope: current.scope })).toEqual(counts);
      expect(readRows()).toEqual(rows);
    });

  it.each(['qa', 'source', 'grant', 'configuration', 'page', 'withdrawal'] as const)(
    'rejects direct consumption and old receipt replay immediately after %s changes, including after reopening', async change => {
      const current = await fixture();
      const plan = await current.prepare();
      await current.publish(plan.key);
      const file = join(dirname(current.file), 'experience.sqlite');
      const experience = new ExperienceStore({ file, knowledge: current.options });
      cleanups.push(() => experience.close());
      const record = experience.recall(current.query)[0];
      expect(record).toBeDefined();
      const context = { applicability: current.query.applicability };
      const adoption = { id: record.id, scope: current.scope, source: { runId: 'consumer', workItemId: `${current.scope}#20` } };
      const receipt = experience.adopt(adoption, { actual: context, verified: context });
      const before = experience.metrics({ scope: current.scope });
      if (change === 'qa') await current.append('independent-qa', [{ kind: 'qa.failed', reason: 'Retry recurred' }]);
      if (change === 'source') writeFileSync(current.sourceInput.path, 'changed source\n');
      if (change === 'grant') { current.grant.revoked = true; current.persistGrant(); }
      if (change === 'configuration') { current.configuration.checkers[0].allowLessonValidation = false; current.persistConfiguration(); }
      if (change === 'page') writeFileSync(current.target, page('Edited', 'Manual replacement'));
      if (change === 'withdrawal') {
        await current.append('independent-qa', [{ kind: 'qa.failed', reason: 'Withdraw lesson' }]);
        await reconcileConfiguredKnowledge(current.options);
      }
      expect(experience.recall(current.query)).toEqual([]);
      expect(() => experience.adopt(adoption, { actual: context, verified: context })).toThrow('matching verified applicability');
      expect(experience.metrics({ scope: current.scope })).toEqual(before);
      if (change !== 'withdrawal') {
        expect(current.store.getCandidate(current.candidate.id)?.state).toBe('published');
        expect(current.store.getPublication(plan.key)?.phase).toBe('committed');
      }
      experience.close();
      const reopened = new ExperienceStore({ file, knowledge: current.options });
      cleanups.push(() => reopened.close());
      expect(reopened.recall(current.query)).toEqual([]);
      expect(() => reopened.adopt(adoption, { actual: context, verified: context })).toThrow('matching verified applicability');
      expect(reopened.metrics({ scope: current.scope }).adoptions).toBe(receipt.adoptions);
    });

  it('repairs a missing experience projection through reconciliation without replacing publication identity', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    await current.publish(plan.key);
    const file = join(dirname(current.file), 'experience.sqlite');
    rmSync(file);
    const publication = current.store.getPublication(plan.key);
    expect(await reconcileConfiguredKnowledge(current.options)).toMatchObject({ blocked: [] });
    const experience = new ExperienceStore({ file, knowledge: current.options });
    cleanups.push(() => experience.close());
    expect(experience.recall(current.query)).toHaveLength(1);
    expect(current.store.getPublication(plan.key)).toEqual(publication);
  });

  it('shares synchronous and asynchronous live publication checks without reconciliation', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    await current.publish(plan.key);
    const input = { store: current.store, policy: current.grant.policy, wikiScript,
      recoveryDirectory: current.options.recoveryDirectory, authorizationFile: current.authorizationFile,
      validationConfigurationFile: current.configurationFile, key: plan.key, applicability: current.query.applicability };
    const published = readCurrentPublishedKnowledge(input);
    expect(published).toMatchObject({ path: 'Retry.md', content: readFileSync(current.target, 'utf8'),
      classification: 'lesson', applicability: { versions: ['fixture-v1'] } });
    expect(await readPublishedKnowledge(input)).toEqual(published);
    const mismatched = { ...input, applicability: { version: 'fixture-v2' } };
    expect(readCurrentPublishedKnowledge(mismatched)).toBeNull();
    expect(await readPublishedKnowledge(mismatched)).toBeNull();
    await current.append('independent-qa', [{ kind: 'qa.failed', reason: 'Competing retry recurred' }]);
    expect(readCurrentPublishedKnowledge(input)).toBeNull();
    expect(await readPublishedKnowledge(input)).toBeNull();
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('published');
    expect(current.store.getPublication(plan.key)?.phase).toBe('committed');
    expect(current.provider.verify).toHaveBeenCalledTimes(1);
  });

  it('propagates the original abort reason through both publication read APIs', async () => {
    const current = await fixture();
    const plan = await current.prepare();
    await current.publish(plan.key);
    const reason = new Error('Stop publication read');
    const input = { store: current.store, policy: current.grant.policy, wikiScript,
      recoveryDirectory: current.options.recoveryDirectory, authorizationFile: current.authorizationFile,
      validationConfigurationFile: current.configurationFile, key: plan.key, applicability: current.query.applicability,
      signal: AbortSignal.abort(reason) };
    let thrown: unknown;
    try { readCurrentPublishedKnowledge(input); } catch (error) { thrown = error; }
    expect(thrown).toBe(reason);
    await expect(readPublishedKnowledge(input)).rejects.toBe(reason);
  });

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
    const publications = current.store.listPublications();
    const candidate = current.store.getCandidate(current.candidate.id);
    await expect(current.prepare()).rejects.toThrow(/lesson_publication_/);
    expect(changed).toBe(true);
    expect(current.store.listPublications()).toEqual(publications);
    expect(current.store.getCandidate(current.candidate.id)).toEqual(candidate);
    expect(current.store.listPublications()).toHaveLength(operation === 'prepare' ? 0 : 1);
    expect(existsSync(current.target)).toBe(false);
    expect(await current.context.gather(current.query)).toEqual([]);
    await reconcileConfiguredKnowledge(current.options);
    expect(current.store.listPublications().map(publication => publication.phase)).toEqual(operation === 'prepare' ? [] : ['conflict']);
    expect(current.store.getCandidate(current.candidate.id)?.state).toBe('conflict');
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
