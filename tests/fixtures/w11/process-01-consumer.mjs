import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { observe } from './process-01-counter.mjs';

export function publicationReceipt({ store, fixture, binary, cliVersion, jobs, withdrawn = false }) {
  const read = name => JSON.parse(readFileSync(join(fixture, `${name}.json`), 'utf8'));
  const { source, requestKey, snapshot, version, binary: producerBinary } = read('intake');
  assert.equal(producerBinary, binary);
  assert.equal(version, cliVersion);
  const scope = 'github:w11/parcel';
  const job = jobs.find(job => job.jobId === requestKey && job.sourceRunId === source.runId && job.scope === scope
    && job.workItemId === source.workItemId && job.status === 'processed');
  const attempt = job?.attempts.find(attempt => attempt.requestKey === requestKey && attempt.status === 'succeeded'
    && attempt.analysisRunId && attempt.sessionId && attempt.usage?.totalTokens > 0);
  assert.ok(attempt, 'Missing successful real extraction attempt');
  const publications = store.listPublications().filter(pub => pub.phase === 'committed' && pub.targetRef === 'wiki:return-handoff'
    && store.getCandidate(pub.candidateId)?.requestKey === requestKey);
  assert.equal(publications.length, 1, 'Expected one committed process-01 publication from the real extraction');
  const [publication] = publications;
  const candidate = store.getCandidate(publication.candidateId);
  const validation = store.getValidation(candidate.id);
  const extracted = read('extraction').candidates.find(item => item.id === candidate.id && item.requestKey === requestKey);
  assert.deepEqual(extracted?.proposal, candidate.proposal);
  if (!withdrawn) assert.equal(candidate.state, 'published');
  assert.equal(candidate.proposal.kind, 'process');
  assert.equal(candidate.proposal.payload.entry, 'return-handoff');
  assert.equal(candidate.proposal.applicability.project, scope);
  assert.ok(candidate.proposal.applicability.environments.includes('staging'));
  assert.ok(candidate.proposal.applicability.versions.includes('2.0'));
  assert.equal(candidate.evidenceDigest, snapshot.digest);
  assert.ok(validation?.passed);
  assert.equal(validation.validatedVersion, 2);
  assert.equal(publication.candidateVersion, validation.validatedVersion);
  assert.equal(publication.candidateDigest, candidate.digest);
  assert.equal(validation.candidateDigest, candidate.digest);
  assert.equal(validation.evidenceDigest, candidate.evidenceDigest);
  assert.equal(publication.evidenceDigest, candidate.evidenceDigest);
  assert.equal(publication.validatorVersion, validation.validatorVersion);
  assert.equal(publication.observedDigest, publication.targetDigest);
  assert.deepEqual(read('publication'), publication);
  const publicationDirectory = join(fixture, '.afk/learning/publications', publication.key);
  assert.equal(existsSync(join(publicationDirectory, 'withdrawal.json')), withdrawn);
  if (withdrawn) {
    const result = read('withdrawal-check');
    assert.equal(result.status, 'withdrawn');
    assert.deepEqual(JSON.parse(readFileSync(join(publicationDirectory, 'withdrawal-result.json'), 'utf8')), result);
  }
  const { assertions, binding } = read('independent-check');
  assert.equal(binding.candidateId, candidate.id);
  assert.equal(binding.evidenceDigest, candidate.evidenceDigest);
  assert.equal(validation.validatorVersion, `learning-validation-v1:${binding.executionId}`);
  const authority = observe(join(fixture, 'desk/returns.sqlite'), source.bag);
  assert.deepEqual(assertions.find(item => item.node === 'process.stepCount')?.actual, String(authority.steps.length));
  assert.ok(assertions.every(item => item.status === 'observed'));
  return { cliVersion, binary, scope, logicalKey: candidate.proposal.payload.entry, edition: validation.validatedVersion,
    productVersion: '2.0', requestKey, sourceRun: source.runId, sourceSession: source.sessionId,
    analysisRun: attempt.analysisRunId, analysisSession: attempt.sessionId, publication, authority };
}

export function gradeProcess(answer, receipt) {
  const { steps, completion } = receipt.authority;
  const { key, targetRef } = receipt.publication;
  assert.deepEqual(answer, { steps, completion, source: `knowledge:${key}; target:${targetRef}`, productVersion: receipt.productVersion });
}
