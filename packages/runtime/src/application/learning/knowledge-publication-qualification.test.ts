import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CandidateStore } from './candidate-store.js';
import { candidateProposalSchema } from './contracts.js';
import { knowledgeFixture } from './knowledge.fixture.spec.js';
import { output } from './ledger-data.fixture.spec.js';
import { prepareKnowledgePublication, publishLearningCandidate, readCurrentPublishedKnowledge } from './publication.js';

const fixtures: ReturnType<typeof knowledgeFixture>[] = [];
const proposalFor = (kind: 'fact' | 'process', targetRef = 'wiki:approval') => candidateProposalSchema.parse(kind === 'fact'
  ? { ...output.candidates[0], targetRef }
  : { ...output.candidates[0], kind, targetRef, payload: { entry: 'approval requested', systems: ['approval-service'],
    preconditions: ['authenticated'], steps: [{ id: 'approve', action: 'approve request', stateChange: 'pending -> approved', evidenceIds: ['e1'] }],
    exceptions: ['request denied'], completion: 'request approved' } });
const open = (kind: 'fact' | 'process', targetRef?: string) => {
  const fixture = knowledgeFixture(proposalFor(kind, targetRef));
  fixtures.push(fixture);
  return fixture;
};
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

const defects = ['configuration', 'authorization', 'oracle', 'source'] as const;
function changeQualification(fixture: ReturnType<typeof open>, defect: typeof defects[number]) {
  const configurationFile = fixture.input.validationConfigurationFile;
  const config = JSON.parse(readFileSync(configurationFile, 'utf8')) as {
    checkers: Array<{ authorizationFile: string; target: { root: string; path: string } }>;
  };
  const checker = config.checkers[0]!;
  const path = defect === 'configuration' ? configurationFile : defect === 'authorization'
    ? checker.authorizationFile : defect === 'source' ? fixture.evidenceSourcePath : join(checker.target.root, checker.target.path);
  const original = readFileSync(path);
  if (defect === 'configuration') rmSync(path);
  else if (defect === 'authorization') writeFileSync(path, JSON.stringify({ ...JSON.parse(original.toString('utf8')), revoked: true }));
  else writeFileSync(path, 'oracle changed after validation\n');
  return () => writeFileSync(path, original, { mode: 0o600 });
}

describe.each(['fact', 'process'] as const)('current %s qualification through publication entry points', kind => {
  it.each(defects)('rejects preparation after %s changes', async defect => {
    const fixture = open(kind);
    changeQualification(fixture, defect);
    await expect(prepareKnowledgePublication(fixture.input)).rejects.toThrow(/^knowledge_publication_/);
    expect(fixture.store.listPublications()).toEqual([]);
    expect(existsSync(join(fixture.vault, '知识/Approval.md'))).toBe(false);
  });

  it.each(defects)('stops recall and permits withdrawal after %s changes across ledger restart', async defect => {
    const fixture = open(kind);
    const prepared = await prepareKnowledgePublication(fixture.input);
    await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    const query = { ...fixture.input, key: prepared.key, applicability: { version: 'abc' } };
    expect(readCurrentPublishedKnowledge(query)).not.toBeNull();
    const restore = changeQualification(fixture, defect);
    expect(readCurrentPublishedKnowledge(query)).toBeNull();
    fixture.store.close();
    const store = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
    try {
      const input = { ...query, store };
      expect(readCurrentPublishedKnowledge(input)).toBeNull();
      const result = await publishLearningCandidate(input);
      expect(result.withdrawal?.status).toBe('withdrawn');
      expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
      restore();
      expect(readCurrentPublishedKnowledge(input)).toBeNull();
      expect((await publishLearningCandidate(input)).withdrawal?.status).toBe('withdrawn');
    } finally { store.close(); }
  });

  it('refuses prepared publication if the validation configuration disappears', async () => {
    const fixture = open(kind);
    const prepared = await prepareKnowledgePublication(fixture.input);
    changeQualification(fixture, 'configuration');
    const result = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(result.withdrawal?.status).toBe('withdrawn');
    expect(existsSync(join(fixture.vault, '知识/Approval.md'))).toBe(false);
  });

  it('requires qualification for complete knowledge even when the authorized target is an inbox', async () => {
    const fixture = open(kind, 'wiki:inbox');
    changeQualification(fixture, 'configuration');
    await expect(prepareKnowledgePublication(fixture.input)).rejects.toThrow(/^knowledge_publication_/);
    expect(fixture.store.listPublications()).toEqual([]);
  });
});
