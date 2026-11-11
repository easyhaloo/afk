import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidationReceipt } from './candidate-store.js';
import { canonicalLearningJson } from './requests.js';
import { createLessonPublicationFixture } from './lesson-publication.fixture.spec.js';
import { assertCurrentLessonPublication, verifyLessonPublication } from './lesson-publication-guard.js';

const revision = 'a'.repeat(40);
const bytesDigest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanups.splice(0).reverse().forEach(cleanup => cleanup()); });
const fixture = (managed = false) => createLessonPublicationFixture({ managed, registerCleanup: cleanup => cleanups.push(cleanup) });

describe('lesson publication guard with real production validation receipts', () => {
  it.each(['AGENTS.md', '.tools/wiki-lint.py', 'nested/AGENTS.md', 'nested/child/AGENTS.md'])(
    'pins present and absent authorization rules through the final source checks: %s', async rule => {
      const current = await createLessonPublicationFixture({ targetDirectory: 'nested/child',
        registerCleanup: cleanup => cleanups.push(cleanup) });
      expect(verifyLessonPublication(current.input).status).toBe('current');
      const originalCursor = current.store.getScanCursor.bind(current.store);
      vi.spyOn(current.store, 'getScanCursor').mockImplementationOnce(identity => {
        mkdirSync(dirname(join(current.vault, rule)), { recursive: true });
        writeFileSync(join(current.vault, rule), '# Changed during guard\n');
        return originalCursor(identity);
      });
      expect(verifyLessonPublication(current.input)).toEqual({ status: 'blocked', code: 'authorization_changed' });
      expect(current.store.getCandidate(current.candidate.id)).toEqual(current.candidate);
      expect(current.store.getValidation(current.candidate.id)).toEqual(current.receipt);
    });

  it('keeps an optional sibling fact unvalidated on the same source when only QA changes', async () => {
    const current = await createLessonPublicationFixture({ includeFact: true, versions: ['fixture-v1'],
      registerCleanup: cleanup => cleanups.push(cleanup) });
    expect(current.candidateIds).toHaveLength(2);
    const factId = current.candidateIds.find(id => id !== current.candidate.id)!;
    const fact = current.store.getCandidate(factId)!;
    expect(fact).toMatchObject({ state: 'candidate', version: 1, requestKey: current.candidate.requestKey,
      evidenceDigest: current.candidate.evidenceDigest, proposal: { kind: 'fact', evidenceIds: current.candidate.proposal.evidenceIds,
        applicability: { project: current.scope, versions: ['fixture-v1'] } } });
    expect(current.store.getValidation(factId)).toBeUndefined();
    expect(verifyLessonPublication(current.input).status).toBe('current');
    await current.append('independent-qa', [{ kind: 'qa.failed' }]);
    expect(verifyLessonPublication(current.input)).toEqual({ status: 'blocked', code: 'audit_changed' });
    expect(current.store.getCandidate(factId)).toEqual(fact);
    expect(current.store.getCandidate(current.candidate.id)).toEqual(current.candidate);
    expect(current.store.getRequest(current.source.key)?.blockedReason).toBeUndefined();
  });

  it('keeps explicit fixture versions aligned with the actual independent oracle and receipt', async () => {
    const current = await createLessonPublicationFixture({ versions: ['fixture-v1'], registerCleanup: cleanup => cleanups.push(cleanup) });
    expect(current.candidate.proposal.applicability.versions).toEqual(['fixture-v1']);
    expect(JSON.parse(readFileSync(current.oracle, 'utf8'))['lesson.versions']).toEqual(['fixture-v1']);
    expect(verifyLessonPublication(current.input).status).toBe('current');
    expect(current.file).toBe(join(current.root, 'ledger', 'candidates.sqlite'));
    expect(current.vault).toBe(current.grant.policy.vault);
  });

  it('accepts v1 QA evidence for the actual validated v2 and journal-published v3 without writing', async () => {
    const current = await fixture();
    const before = current.store.getCandidate(current.candidate.id);
    const result = verifyLessonPublication(current.input);
    expect(result).toMatchObject({ status: 'current', binding: { candidateId: current.candidate.id,
      candidateVersion: 1, validatedVersion: 2, executionId: current.decode().report.binding.executionId, qa: { targetRevision: revision } } });
    expect(result.status === 'current' && result.evidence).toHaveLength(5);
    expect(assertCurrentLessonPublication(current.input)).toBeUndefined();
    expect(current.store.getCandidate(current.candidate.id)).toEqual(before);
    expect(current.store.getValidation(current.candidate.id)).toEqual(current.receipt);
    const key = bytesDigest('publication');
    const targetDigest = bytesDigest('target');
    current.store.preparePublication(current.candidate.id, 2, { key, targetRef: 'wiki:retry', validatorVersion: current.receipt.validatorVersion,
      originalDigest: null, targetDigest, recoveryRef: `wiki:${key}` });
    current.store.advancePublication(key, 'applied', targetDigest);
    current.store.advancePublication(key, 'committed', targetDigest);
    expect(verifyLessonPublication({ ...current.input, candidate: current.store.getCandidate(current.candidate.id)! }).status).toBe('current');
    expect(vi.mocked(current.provider.verify)).toHaveBeenCalledTimes(1);
  });

  it('resolves registered managed sources without a second saved manifest and rejects changed transcripts', async () => {
    const current = await fixture(true);
    expect(verifyLessonPublication(current.input).status).toBe('current');
    writeFileSync(current.transcript, '{}\n');
    expect(verifyLessonPublication(current.input).status).toBe('blocked');
  });

  it.each(['analysisRunId', 'sessionId'] as const)('rejects post-validation QA identity binding through %s', async field => {
    const current = await fixture();
    current.store.startAnalysisAttempt({ requestKey: current.source.key, callId: 'late-analysis', day: '2026-11-12', limit: 20,
      startedAt: '2026-11-12T00:00:00Z' });
    expect(verifyLessonPublication(current.input).status).toBe('current');
    current.store.recordAnalysisIdentity('late-analysis', { analysisRunId: 'different-run', sessionId: 'different-session', [field]: 'independent-qa' });
    expect(verifyLessonPublication(current.input)).toEqual({ status: 'blocked', code: 'qa_not_independent' });
    expect(current.store.getCandidate(current.candidate.id)).toEqual(current.candidate);
    expect(current.store.getValidation(current.candidate.id)).toEqual(current.receipt);
  });

  it.each([true, false])('rechecks live identities at return without rejecting unrelated identities: collision=%s', async collision => {
    const current = await fixture();
    current.store.startAnalysisAttempt({ requestKey: current.source.key, callId: 'late-analysis', day: '2026-11-12', limit: 20,
      startedAt: '2026-11-12T00:00:00Z' });
    const original = current.store.getValidation.bind(current.store);
    vi.spyOn(current.store, 'getValidation').mockImplementationOnce(id => {
      current.store.recordAnalysisIdentity('late-analysis', { analysisRunId: collision ? 'independent-qa' : 'another-analysis', sessionId: 'another-session' });
      return original(id);
    });
    expect(verifyLessonPublication(current.input).status).toBe(collision ? 'blocked' : 'current');
  });

  it.each(['qa', 'rootCause', 'fixTargetRevision', 'qa-ref', 'source-ref', 'executionId', 'candidateVersion', 'target', 'checksum', 'protocol'] as const)
    ('rejects a forged or historical receipt: %s', async defect => {
      const current = await fixture();
      current.rewrite(envelope => {
        if (defect === 'qa') delete envelope.report.binding.qa;
        if (defect === 'rootCause') envelope.report.assertions.find((entry: { node: string }) => entry.node === 'lesson.rootCause').actual = 'invented';
        if (defect === 'fixTargetRevision') envelope.report.assertions.find((entry: { node: string }) => entry.node === 'lesson.fixTargetRevision').actual = 'b'.repeat(40);
        if (defect === 'qa-ref') envelope.report.binding.qaEvidence[0].digest = '0'.repeat(64);
        if (defect === 'source-ref') envelope.report.assertions[0].evidence[0].digest = '0'.repeat(64);
        if (defect === 'executionId') envelope.report.binding.executionId = '00000000-0000-4000-8000-000000000000';
        if (defect === 'candidateVersion') envelope.report.binding.candidateVersion = 2;
        if (defect === 'target') envelope.report.binding.target.scope = 'github:foreign/repository';
        if (defect === 'protocol') envelope.report.protocol = 'learning-validation-v0';
      });
      if (defect === 'checksum') {
        const receipt = current.store.getValidation(current.candidate.id)!;
        const envelope = current.decode();
        envelope.receiptDigest = '0'.repeat(64);
        vi.mocked(current.store.getValidation).mockReturnValue({ ...receipt,
          results: Buffer.from(canonicalLearningJson(envelope)).toString('base64').match(/.{1,1800}/g)!.map(chunk => `json-base64-v1:${chunk}`) });
      }
      expect(verifyLessonPublication(current.input).status).toBe('blocked');
      expect(() => assertCurrentLessonPublication(current.input)).toThrow(/^lesson_publication_/);
      expect(current.store.getCandidate(current.candidate.id)?.version).toBe(2);
    });

  it.each(['missing', 'permission', 'checker', 'scope', 'qa-pin', 'qa-run', 'replaced'] as const)('rejects missing or changed saved configuration: %s', async defect => {
    const current = await fixture();
    if (defect === 'permission') current.configuration.checkers[0].allowLessonValidation = false;
    if (defect === 'checker') current.configuration.checkers[0].version = '2';
    if (defect === 'scope') current.configuration.checkers[0].scope = 'github:foreign/repository';
    if (defect === 'qa-pin') current.configuration.checkers[0].qa.auditDigest = '0'.repeat(64);
    if (defect === 'qa-run') current.configuration.checkers[0].qa.runId = 'original-failure';
    if (defect === 'replaced') rmSync(current.configurationFile);
    current.persistConfiguration();
    const input = { ...current.input, configurationFile: defect === 'missing' ? undefined : current.configurationFile };
    expect(verifyLessonPublication(input).status).toBe('blocked');
    expect(JSON.stringify(verifyLessonPublication(input))).not.toContain(current.root);
  });

  it.each(['late-failure', 'late-commit', 'missing', 'corrupt'] as const)('refuses changed QA bytes without trusting old passed: %s', async defect => {
    const current = await fixture();
    if (defect === 'late-failure') await current.append('independent-qa', [{ kind: 'qa.failed' }]);
    if (defect === 'late-commit') await current.append('independent-qa', [{ kind: 'commit.recorded', phase: 'qa', commitSha: revision, branch: 'qa' },
      { kind: 'run.finished', outcome: 'succeeded' }]);
    if (defect === 'missing') rmSync(current.qaPath);
    if (defect === 'corrupt') writeFileSync(current.qaPath, 'invalid');
    expect(verifyLessonPublication(current.input).status).toBe('blocked');
    expect(current.store.getValidation(current.candidate.id)).toEqual(current.receipt);
  });

  it.each(['source-bytes', 'blocked', 'oracle', 'grant', 'rules'] as const)('rejects current dependency invalidation: %s', async defect => {
    const current = await fixture();
    if (defect === 'source-bytes') writeFileSync(current.sourceInput.path, 'changed');
    if (defect === 'blocked') current.store.invalidateRequestSource(current.source.key);
    if (defect === 'oracle') writeFileSync(current.oracle, '{}');
    if (defect === 'grant') { current.grant.revoked = true; current.persistGrant(); }
    if (defect === 'rules') writeFileSync(join(current.grant.policy.vault, 'AGENTS.md'), 'changed');
    const candidate = current.store.getCandidate(current.candidate.id)!;
    expect(verifyLessonPublication({ ...current.input, candidate }).status).toBe('blocked');
  });

  it.each(['config', 'qa', 'source', 'oracle'] as const)('rejects symlinked %s and closes read descriptors', async target => {
    const current = await fixture();
    const path = target === 'config' ? current.configurationFile : target === 'qa' ? current.qaPath : target === 'source' ? current.sourceInput.path : current.oracle;
    const replacement = join(current.root, 'replacement');
    writeFileSync(replacement, readFileSync(path));
    rmSync(path);
    symlinkSync(replacement, path);
    expect(verifyLessonPublication(current.input).status).toBe('blocked');
  });

  it.each(['permissions', 'hardlink', 'oversized', 'malformed'])('fails closed on unsafe private configuration: %s', async defect => {
    const current = await fixture();
    if (defect === 'permissions') chmodSync(current.configurationFile, 0o644);
    if (defect === 'hardlink') linkSync(current.configurationFile, join(current.root, 'linked'));
    if (defect === 'oversized') writeFileSync(current.configurationFile, 'x'.repeat(1024 * 1024 + 1));
    if (defect === 'malformed') writeFileSync(current.configurationFile, '{');
    expect(verifyLessonPublication(current.input).status).toBe('blocked');
  });

  it.each([[], ['passed'], ['json-base64-v1:!!!!'], Array(33).fill('json-base64-v1:e30=')])('rejects bounded invalid receipt chunks %j', async results => {
    const current = await fixture();
    vi.spyOn(current.store, 'getValidation').mockReturnValue({ ...current.receipt, results } as ValidationReceipt);
    expect(verifyLessonPublication(current.input).status).toBe('blocked');
  });

  it('returns safe cancellation for null and ordinary reasons without calling a model', async () => {
    const current = await fixture();
    for (const reason of [null, new Error(current.root), undefined]) {
      const controller = new AbortController();
      controller.abort(reason);
      expect(verifyLessonPublication(current.input, { signal: controller.signal })).toEqual({ status: 'blocked', code: 'cancelled' });
    }
    expect(vi.mocked(current.provider.verify)).toHaveBeenCalledTimes(1);
  });

  it('fails closed for stale caller snapshots and unknown ledger read errors', async () => {
    const current = await fixture();
    expect(verifyLessonPublication({ ...current.input, candidate: { ...current.candidate, version: 3 } }).status).toBe('blocked');
    vi.spyOn(current.store, 'getValidation').mockImplementation(() => { throw new Error(current.root); });
    expect(verifyLessonPublication(current.input)).toEqual({ status: 'blocked', code: 'storage_unavailable' });
    expect(() => assertCurrentLessonPublication(current.input)).toThrow('lesson_publication_storage_unavailable');
  });
});
