import filesystem from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { candidateProposalSchema } from './contracts.js';
import { knowledgeFixture } from './knowledge.fixture.spec.js';
import { KnowledgeContextProvider, reconcileConfiguredKnowledge } from './knowledge-runtime.js';
import { output } from './ledger-data.fixture.spec.js';
import { prepareKnowledgePublication, publishLearningCandidate, readCurrentPublishedKnowledge } from './publication.js';
import type { KnowledgeSourceReadGrant } from './source-read-grant.js';

afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });

it('applies a live source grant to a legacy process without changing its publication', async () => {
  const fixture = knowledgeFixture(candidateProposalSchema.parse({ ...output.candidates[0], kind: 'process', targetRef: 'wiki:approval', payload: {
    entry: 'Submit order', systems: ['API'], preconditions: ['Authenticated'],
    steps: [{ id: 'submit', action: 'Submit', stateChange: 'new → queued', evidenceIds: ['e1'] }],
    exceptions: ['Rejected'], completion: 'Order queued',
  } }));
  try {
    const { key } = await prepareKnowledgePublication(fixture.input);
    const { publication } = await publishLearningCandidate({ ...fixture.input, key });
    const applicability = { version: 'abc' };
    const legacy = readCurrentPublishedKnowledge({ ...fixture.input, key, applicability });
    expect(legacy?.classification).toBe('process');
    const page = join(fixture.vault, legacy!.path);
    const source = fixture.evidenceSourcePath;
    const snapshot = join(fixture.recoveryDirectory, key, 'plan.json');
    const watched = [source, fixture.validationTargetPath, page, snapshot];
    const original = watched.map(path => filesystem.readFileSync(path));
    const sourceReadGrantFile = join(fixture.root, 'read.json');
    const config = { wikiScript: fixture.wikiScript, grants: [fixture.authorizationFile], sourceReadGrantFile };
    const options = { ...fixture.input, file: join(fixture.root, 'ledger.sqlite'), config };
    const provider = new KnowledgeContextProvider(options);
    const scope = fixture.policy.scope;
    const query = { scope, prompt: 'Submit order', applicability };
    const read = () => readCurrentPublishedKnowledge({ ...fixture.input, key, applicability, sourceReadGrantFile });
    const grant = { scope, targetRef: publication.targetRef, evidenceDigest: publication.evidenceDigest, revoked: false,
      paths: [source, fixture.validationTargetPath] };
    const save = (...grants: KnowledgeSourceReadGrant[]) => filesystem.writeFileSync(sourceReadGrantFile,
      JSON.stringify({ version: 1, grants }), { mode: 0o600 });
    const opened = vi.spyOn(filesystem, 'openSync');
    const readFile = vi.spyOn(filesystem, 'readFileSync');
    syncBuiltinESMExports();
    const accessed = () => [...opened.mock.calls, ...readFile.mock.calls].map(call => call[0]);
    const denyBeforeContent = async () => {
      opened.mockClear(); readFile.mockClear();
      expect(read()).toBeNull();
      expect(await provider.gather(query)).toEqual([]);
      for (const path of watched) expect(accessed()).not.toContain(path);
    };
    await denyBeforeContent();
    save(grant);
    expect(await provider.gather(query)).toMatchObject([{ content: legacy!.content }]);
    for (const path of watched) expect(accessed()).toContain(path);
    save({ ...grant, revoked: true });
    await denyBeforeContent();
    expect(await new KnowledgeContextProvider(options).gather(query)).toEqual([]);
    expect(await reconcileConfiguredKnowledge(options)).toMatchObject({ results: [{ publication }], blocked: [] });
    expect(fixture.store.getPublication(key)).toEqual(publication);
    expect(fixture.store.getCandidate(publication.candidateId)?.state).toBe('published');
    expect(watched.map(path => filesystem.readFileSync(path))).toEqual(original);
    for (const grants of [[{ ...grant, scope: 'github:other/api' }], [{ ...grant, targetRef: 'wiki:other' }],
      [{ ...grant, evidenceDigest: '0'.repeat(64) }], [grant, { ...grant, revoked: true }]]) {
      save(...grants);
      await denyBeforeContent();
    }
    for (const path of grant.paths) {
      save({ ...grant, paths: grant.paths.filter(value => value !== path) });
      opened.mockClear(); readFile.mockClear();
      expect(read()).toBeNull();
      expect(accessed()).not.toContain(path);
      expect(accessed()).not.toContain(page);
    }
    filesystem.writeFileSync(sourceReadGrantFile, '{');
    await denyBeforeContent();
    save(grant);
    filesystem.chmodSync(sourceReadGrantFile, 0o644);
    await denyBeforeContent();
    filesystem.chmodSync(sourceReadGrantFile, 0o600);
    expect(read()).toEqual(legacy);
  } finally { fixture.cleanup(); }
});
