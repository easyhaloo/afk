import { spawn } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CandidateStore } from './candidate-store.js';
import { hash, knowledgeFixture, page } from './knowledge.fixture.spec.js';
import { prepareKnowledgePublication, publishLearningCandidate, readPublishedKnowledge, reconcileKnowledgePublications, resolveKnowledgePublication } from './publication.js';
import * as knowledge from './knowledge.js';
import { candidateProposalSchema } from './contracts.js';
import { output } from './ledger-data.fixture.spec.js';
import { acquirePublicationLock } from './publication-lock.js';
import { KnowledgeContextProvider, reconcileConfiguredKnowledge } from './knowledge-runtime.js';

const fixtures: ReturnType<typeof knowledgeFixture>[] = [];
const open = (proposal?: Parameters<typeof knowledgeFixture>[0]) => { const fixture = knowledgeFixture(proposal); fixtures.push(fixture); return fixture; };
afterEach(() => { vi.restoreAllMocks(); for (const fixture of fixtures.splice(0)) fixture.cleanup(); });

describe('publication cancellation reasons', () => {
  it.each(['null', 'error', 'default'] as const)('preserves the %s entry reason before touching the vault', async kind => {
    const fixture = open();
    const controller = new AbortController();
    controller.abort(kind === 'null' ? null : kind === 'error' ? new Error('publication cancelled') : undefined);
    const reason = controller.signal.reason;
    const planner = vi.spyOn(knowledge, 'planKnowledgePublication');
    await expect(prepareKnowledgePublication({ ...fixture.input, signal: controller.signal })).rejects.toBe(reason);
    await expect(publishLearningCandidate({ ...fixture.input, key: 'unused', signal: controller.signal })).rejects.toBe(reason);
    expect(planner).not.toHaveBeenCalled();
    expect(fixture.store.listPublications()).toEqual([]);
    expect(fixture.store.getCandidate(fixture.candidate.id)).toEqual(fixture.candidate);
    expect(existsSync(join(fixture.vault, '.learning-publication.lock'))).toBe(false);
    expect(existsSync(fixture.recoveryDirectory)).toBe(false);
  });

  it.each([new Error('preview failed'), { failure: 'unknown preview rejection' }, null])(
    'propagates non-cancellation rejection %j and releases the queue', async failure => {
      const fixture = open();
      const controller = new AbortController();
      const planner = vi.spyOn(knowledge, 'planKnowledgePublication').mockRejectedValueOnce(failure);
      await expect(prepareKnowledgePublication({ ...fixture.input, signal: controller.signal })).rejects.toBe(failure);
      expect(controller.signal.aborted).toBe(false);
      expect(fixture.store.listPublications()).toEqual([]);
      planner.mockRestore();
      expect((await prepareKnowledgePublication(fixture.input)).phase).toBe('prepared');
    });
});

async function navigationDrift() {
  const fixture = open();
  fixture.policy.targets.push({ ...fixture.policy.targets[0], ref: 'wiki:billing', paths: ['知识/Billing.md'] });
  fixture.persistGrant();
  const source = fixture.store.getRequest(fixture.candidate.requestKey)!;
  const request = fixture.store.submitRequest({ request: { ...source.request, sourceId: 'run:billing', sourceRunId: 'billing' }, evidence: source.evidence });
  const processed = fixture.store.completeRequest(request.key, { version: 1, warnings: [], candidates: [candidateProposalSchema.parse({
    ...output.candidates[0], title: 'Billing', statement: 'Billing needs review', targetRef: 'wiki:billing',
    payload: { subject: 'billing', rule: 'Review bills before payment', classification: 'fact' },
  })] });
  const candidate = fixture.store.getCandidate(processed.candidateIds[0]!)!;
  const validated = fixture.store.recordValidation(candidate.id, candidate.version, { candidateDigest: candidate.digest,
    evidenceDigest: candidate.evidenceDigest, validatorVersion: 'knowledge-v1', passed: true, results: ['fixture billing evidence'] });
  const input = { ...fixture.input, candidateId: validated.id, expectedVersion: validated.version };
  const approval = await prepareKnowledgePublication(fixture.input);
  const stale = await prepareKnowledgePublication(input);
  expect((await publishLearningCandidate({ ...fixture.input, key: approval.key })).publication.phase).toBe('committed');
  return { fixture, input, stale, approval };
}

describe('immutable navigation plan replacement', () => {
  it('repreviews navigation, preserves current text and redirects old keys after restart without duplicate context', async () => {
    const { fixture, input, stale } = await navigationDrift();
    const snapshot = readFileSync(join(fixture.recoveryDirectory, stale.key, 'plan.json'));
    const validation = fixture.store.getValidation(input.candidateId);
    const navigation = join(fixture.vault, '00-总览.md');
    const current = readFileSync(navigation, 'utf8') + '\nHuman navigation note [[知识/入口]].\n';
    writeFileSync(navigation, current);
    const result = await publishLearningCandidate({ ...input, key: stale.key });
    expect(result.publication.phase).toBe('committed');
    expect(result.publication.key).not.toBe(stale.key);
    expect(result.publication.targetDigest).not.toBe(stale.targetDigest);
    expect(fixture.store.getPublication(stale.key)).toMatchObject({ phase: 'superseded', supersededBy: result.publication.key });
    expect(readFileSync(join(fixture.recoveryDirectory, stale.key, 'plan.json'))).toEqual(snapshot);
    expect(readFileSync(navigation, 'utf8')).toContain(current);
    expect(readFileSync(navigation, 'utf8')).toContain('[[知识/Approval]]');
    expect(readFileSync(navigation, 'utf8')).toContain('[[知识/Billing]]');
    expect(fixture.store.getValidation(input.candidateId)).toEqual(validation);
    fixture.store.close();
    const store = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
    const options = { ...input, store };
    try {
      expect((await publishLearningCandidate({ ...options, key: stale.key })).publication.key).toBe(result.publication.key);
      expect(await readPublishedKnowledge({ ...options, key: stale.key, applicability: { version: 'abc' } })).not.toBeNull();
      expect((await reconcileKnowledgePublications(options)).blocked).toEqual([]);
      expect(readFileSync(join(fixture.vault, '知识/Billing.md'), 'utf8')).not.toContain('knowledge_status: revoked');
    } finally { store.close(); }
    const configured = { file: join(fixture.root, 'ledger.sqlite'), recoveryDirectory: fixture.recoveryDirectory,
      config: { wikiScript: fixture.wikiScript, grants: [fixture.authorizationFile] } };
    expect((await reconcileConfiguredKnowledge(configured)).blocked).toEqual([]);
    const provider = new KnowledgeContextProvider(configured);
    const context = await provider.gather({ scope: fixture.policy.scope, prompt: 'Approval Billing', applicability: { version: 'abc' } });
    expect(context).toHaveLength(2);
  });

  it.each(['target', 'template', 'rules', 'authorization', 'authorization-permissions', 'source'] as const)('refuses navigation replacement when %s changed', async changed => {
    const { fixture, input, stale } = await navigationDrift();
    const snapshot = readFileSync(join(fixture.recoveryDirectory, stale.key, 'plan.json'));
    if (changed === 'target') fixture.write('知识/Billing.md', page('Billing', 'Human target content'));
    else if (changed === 'template') fixture.write('知识/_模板.md', page('{{title}}', 'Changed {{knowledge}}'));
    else if (changed === 'rules') fixture.write('AGENTS.md', '# Changed rules\n');
    else if (changed === 'authorization') fixture.persistGrant(true);
    else if (changed === 'authorization-permissions') fixture.persistGrant(false, false);
    else fixture.store.invalidateRequestSource(fixture.store.getCandidate(input.candidateId)!.requestKey);
    await publishLearningCandidate({ ...input, key: stale.key }).catch(() => undefined);
    expect(fixture.store.getPublication(stale.key)?.phase).not.toBe('superseded');
    expect(fixture.store.listPublications(input.candidateId)).toHaveLength(1);
    expect(readFileSync(join(fixture.recoveryDirectory, stale.key, 'plan.json'))).toEqual(snapshot);
    if (changed === 'target') expect(readFileSync(join(fixture.vault, '知识/Billing.md'), 'utf8')).toContain('Human target content');
    else expect(existsSync(join(fixture.vault, '知识/Billing.md'))).toBe(false);
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('knowledge_status: revoked');
  });

  it('replaces prepared plans repeatedly and resolves the entire immutable history inside one publication operation', async () => {
    const { fixture, input, stale } = await navigationDrift();
    const oldSnapshot = readFileSync(join(fixture.recoveryDirectory, stale.key, 'plan.json'));
    const first = await prepareKnowledgePublication(input);
    expect(first.key).not.toBe(stale.key);
    const firstSnapshot = readFileSync(join(fixture.recoveryDirectory, first.key, 'plan.json'));
    const navigation = join(fixture.vault, '知识/入口.md');
    writeFileSync(navigation, readFileSync(navigation, 'utf8') + '\nAdditional navigation text.\n');
    const second = await prepareKnowledgePublication(input);
    expect(second.key).not.toBe(first.key);
    expect((await publishLearningCandidate({ ...input, key: stale.key })).publication.key).toBe(second.key);
    for (const key of [stale.key, first.key, second.key]) {
      expect(resolveKnowledgePublication({ ...input, key })).toMatchObject({ key: second.key, phase: 'committed' });
      expect(existsSync(join(fixture.recoveryDirectory, key, 'withdrawal.json'))).toBe(false);
    }
    expect(readFileSync(join(fixture.recoveryDirectory, stale.key, 'plan.json'))).toEqual(oldSnapshot);
    expect(readFileSync(join(fixture.recoveryDirectory, first.key, 'plan.json'))).toEqual(firstSnapshot);
    expect((await reconcileKnowledgePublications(input)).blocked).toEqual([]);
  });

  it.each(['target', 'template', 'rules', 'authorization', 'authorization-permissions', 'source', 'abort'] as const)('rechecks %s after replacement preview before the journal CAS', async changed => {
    const { fixture, input, stale } = await navigationDrift();
    const controller = new AbortController();
    const reason = new Error('Navigation preview cancelled');
    const original = knowledge.refreshKnowledgeNavigation;
    const supersede = vi.spyOn(fixture.store, 'supersedePreparedPublication');
    vi.spyOn(knowledge, 'refreshKnowledgeNavigation').mockImplementation(async (...arguments_) => {
      const replacement = await original(...arguments_);
      expect(replacement).toBeDefined();
      if (changed === 'target') fixture.write('知识/Billing.md', page('Billing', 'Late human target edit'));
      else if (changed === 'template') fixture.write('知识/_模板.md', page('{{title}}', 'Late {{knowledge}}'));
      else if (changed === 'rules') fixture.write('AGENTS.md', '# Late rules edit\n');
      else if (changed === 'authorization') fixture.persistGrant(true);
      else if (changed === 'authorization-permissions') fixture.persistGrant(false, false);
      else if (changed === 'source') fixture.store.invalidateRequestSource(fixture.store.getCandidate(input.candidateId)!.requestKey);
      else controller.abort(reason);
      return replacement;
    });
    const publishing = publishLearningCandidate({ ...input, key: stale.key, signal: controller.signal });
    if (changed === 'abort') await expect(publishing).rejects.toBe(reason);
    else await publishing.catch(() => undefined);
    expect(supersede).not.toHaveBeenCalled();
    expect(fixture.store.getPublication(stale.key)?.phase).not.toBe('superseded');
    if (changed === 'abort') {
      expect(fixture.store.getPublication(stale.key)?.phase).toBe('prepared');
      expect(existsSync(join(fixture.recoveryDirectory, stale.key, 'withdrawal.json'))).toBe(false);
    }
    if (changed === 'target') expect(readFileSync(join(fixture.vault, '知识/Billing.md'), 'utf8')).toContain('Late human target edit');
    else expect(existsSync(join(fixture.vault, '知识/Billing.md'))).toBe(false);
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('knowledge_status: revoked');
  });

  it.each(['[[知识/入口]]', '[[知识/Approval]]'])('rejects removal of %s while retaining both human and previously published navigation', async link => {
    const { fixture, input, stale } = await navigationDrift();
    const navigation = join(fixture.vault, '00-总览.md');
    const edited = readFileSync(navigation, 'utf8').replace(link, 'Human removed this link');
    writeFileSync(navigation, edited);
    const result = await publishLearningCandidate({ ...input, key: stale.key });
    expect(result.publication.phase).toBe('conflict');
    expect(fixture.store.getPublication(stale.key)?.supersededBy).toBeUndefined();
    expect(readFileSync(navigation, 'utf8')).toBe(edited);
    expect(existsSync(join(fixture.vault, '知识/Billing.md'))).toBe(false);
  });

  it.each(['cycle', 'missing', 'cross-candidate', 'stray-pointer', 'receipt'] as const)('blocks invalid %s redirects without withdrawing the committed successor', async corruption => {
    const { fixture, input, stale, approval } = await navigationDrift();
    const successor = (await publishLearningCandidate({ ...input, key: stale.key })).publication;
    const original = fixture.store.getPublication.bind(fixture.store);
    const old = original(stale.key)!;
    vi.spyOn(fixture.store, 'getPublication').mockImplementation(key => {
      if (key === stale.key) {
        if (corruption === 'cycle') return { ...old, supersededBy: stale.key };
        if (corruption === 'missing') return { ...old, supersededBy: '0'.repeat(64) };
        if (corruption === 'cross-candidate') return { ...old, supersededBy: approval.key };
      }
      if (key === successor.key && corruption === 'stray-pointer') return { ...successor, supersededBy: stale.key };
      return original(key);
    });
    if (corruption === 'receipt') writeFileSync(join(fixture.recoveryDirectory, successor.key, 'supersession.json'), '{}');
    await expect(publishLearningCandidate({ ...input, key: stale.key })).rejects.toThrow();
    expect(await readPublishedKnowledge({ ...input, key: stale.key, applicability: { version: 'abc' } })).toBeNull();
    for (const key of [stale.key, successor.key]) expect(existsSync(join(fixture.recoveryDirectory, key, 'withdrawal.json'))).toBe(false);
    expect(readFileSync(join(fixture.vault, '知识/Billing.md'), 'utf8')).not.toContain('knowledge_status: revoked');
  });

  it('withdraws only the live successor after source invalidation and never the superseded plan', async () => {
    const { fixture, input, stale } = await navigationDrift();
    const successor = (await publishLearningCandidate({ ...input, key: stale.key })).publication;
    fixture.store.invalidateRequestSource(fixture.store.getCandidate(input.candidateId)!.requestKey);
    await reconcileKnowledgePublications(input);
    expect(existsSync(join(fixture.recoveryDirectory, stale.key, 'withdrawal.json'))).toBe(false);
    expect(existsSync(join(fixture.recoveryDirectory, successor.key, 'withdrawal.json'))).toBe(true);
    expect(readFileSync(join(fixture.vault, '知识/Billing.md'), 'utf8')).toContain('knowledge_status: revoked');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('knowledge_status: revoked');
  });

  it('preserves cancellation after the supersession CAS and resumes the successor through the original key', async () => {
    const { fixture, input, stale } = await navigationDrift();
    const controller = new AbortController();
    const reason = new Error('Cancelled after replacement adoption');
    const supersede = fixture.store.supersedePreparedPublication.bind(fixture.store);
    const adopted = vi.spyOn(fixture.store, 'supersedePreparedPublication').mockImplementation((...arguments_) => {
      const successor = supersede(...arguments_);
      controller.abort(reason);
      return successor;
    });
    await expect(publishLearningCandidate({ ...input, key: stale.key, signal: controller.signal })).rejects.toBe(reason);
    const successor = resolveKnowledgePublication({ ...input, key: stale.key });
    expect(successor.phase).toBe('prepared');
    expect(existsSync(join(fixture.vault, '知识/Billing.md'))).toBe(false);
    for (const key of [stale.key, successor.key]) expect(existsSync(join(fixture.recoveryDirectory, key, 'withdrawal.json'))).toBe(false);
    expect((await publishLearningCandidate({ ...input, key: stale.key })).publication).toMatchObject({ key: successor.key, phase: 'committed' });
    expect(adopted).toHaveBeenCalledTimes(1);
  });
});

describe('knowledge publication journal and recovery', () => {
  it('preserves cancellation reason during a real preview and retains the orphan linter lock', async () => {
    const fixture = open();
    const started = join(fixture.root, 'preview-started');
    const release = join(fixture.root, 'preview-release');
    const script = `import json, pathlib, time
started = pathlib.Path(${JSON.stringify(started)})
release = pathlib.Path(${JSON.stringify(release)})
started.touch()
deadline = time.monotonic() + 4
while not release.exists() and time.monotonic() < deadline:
    time.sleep(0.01)
print(json.dumps({'findings': []}))
`;
    fixture.write('.tools/wiki-lint.py', script);
    fixture.policy.rules['.tools/wiki-lint.py'] = hash(script);
    fixture.persistGrant();
    const controller = new AbortController();
    const reason = new Error('preview cancelled by its owner');
    const preparing = prepareKnowledgePublication({ ...fixture.input, signal: controller.signal });
    const rejected = expect(preparing).rejects.toBe(reason);
    try {
      await vi.waitFor(() => expect(existsSync(started)).toBe(true));
      controller.abort(reason);
      await rejected;
      await expect(acquirePublicationLock({ vault: fixture.vault, timeoutMs: 100 })).rejects.toMatchObject({ code: 'publication_lock_timeout' });
      expect(fixture.store.listPublications()).toEqual([]);
    } finally {
      controller.abort(reason);
      writeFileSync(release, 'released');
      await Promise.allSettled([preparing, rejected]);
      const lease = await acquirePublicationLock({ vault: fixture.vault, timeoutMs: 3000 });
      lease.close();
    }
  });

  it('retains the vault kernel lock in real preview, apply and withdrawal linters', async () => {
    const fixture = open();
    const marker = join(fixture.root, 'inherited-lock.jsonl');
    const script = `import fcntl, json, os, pathlib, sys
owner = pathlib.Path(__file__).parent.parent
descriptor = int(os.environ['LEARNING_PUBLICATION_LOCK_FD'])
opened = os.fstat(descriptor)
named = (owner / '.learning-publication.lock').stat()
assert (opened.st_dev, opened.st_ino) == (named.st_dev, named.st_ino)
with (owner / '.learning-publication.lock').open('rb') as contender:
    try:
        fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        pass
    else:
        raise AssertionError('publication lock was not retained')
with (owner.parent / 'inherited-lock.jsonl').open('a') as receipt:
    receipt.write(json.dumps({'vault': sys.argv[sys.argv.index('--vault') + 1]}) + '\\n')
print(json.dumps({'findings': []}))
`;
    fixture.write('.tools/wiki-lint.py', script);
    fixture.policy.rules['.tools/wiki-lint.py'] = hash(script);
    fixture.persistGrant();
    const prepared = await prepareKnowledgePublication(fixture.input);
    const published = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(published.publication.phase).toBe('committed');
    fixture.store.invalidateRequestSource(fixture.candidate.requestKey);
    const withdrawn = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(withdrawn.withdrawal?.status).toBe('withdrawn');
    const receipts = readFileSync(marker, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { vault: string });
    expect(receipts.length).toBeGreaterThanOrEqual(3);
    expect(receipts.some(receipt => receipt.vault !== fixture.vault)).toBe(true);
  });

  it.each(['null', 'error', 'default'] as const)('preserves a queued %s reason without letting a later caller overtake the running publication', async kind => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolveGate => { release = resolveGate; });
    const ready = new Promise<void>(resolveReady => { started = resolveReady; });
    const runWikiIngest = knowledge.runWikiIngest;
    const ingest = vi.spyOn(knowledge, 'runWikiIngest').mockImplementation(async (...args) => {
      started();
      await gate;
      return runWikiIngest(...args);
    });
    const first = publishLearningCandidate({ ...fixture.input, key: prepared.key });
    await ready;
    const controller = new AbortController();
    let cancelled: unknown;
    const second = publishLearningCandidate({ ...fixture.input, key: prepared.key, signal: controller.signal });
    const observed = second.catch(error => { cancelled = error; });
    controller.abort(kind === 'null' ? null : kind === 'error' ? new Error('queued publication cancelled') : undefined);
    const reason = controller.signal.reason;
    let thirdFinished = false;
    const third = publishLearningCandidate({ ...fixture.input, key: prepared.key }).then(result => {
      thirdFinished = true;
      return result;
    });
    try {
      await vi.waitFor(() => expect(cancelled).toBe(reason), { timeout: 500, interval: 10 });
      await new Promise<void>(resolveTurn => setImmediate(resolveTurn));
      expect(thirdFinished).toBe(false);
      expect(ingest).toHaveBeenCalledTimes(1);
      expect(fixture.store.getPublication(prepared.key)?.phase).toBe('prepared');
    } finally {
      release();
      await Promise.allSettled([first, observed, third]);
    }
    expect((await first).publication.phase).toBe('committed');
    expect((await third).publication.phase).toBe('committed');
  });

  it('converges concurrent callers of the same publication without withdrawing valid content', async () => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      publishLearningCandidate({ ...fixture.input, key: prepared.key })));
    expect(results.map(result => result.publication.phase)).toEqual(['committed', 'committed', 'committed', 'committed']);
    expect(results.every(result => result.errorCode === undefined && result.withdrawal === undefined)).toBe(true);
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('published');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('knowledge_status: revoked');
    expect((await reconcileKnowledgePublications(fixture.input)).blocked).toEqual([]);
  });

  it('keeps committed assets valid as shared navigation grows and withdraws only the invalidated asset', async () => {
    const fixture = open();
    fixture.policy.targets.push({ ...fixture.policy.targets[0]!, ref: 'wiki:billing', paths: ['知识/Billing.md'] });
    fixture.persistGrant();
    const approval = await prepareKnowledgePublication(fixture.input);
    await publishLearningCandidate({ ...fixture.input, key: approval.key });
    const source = fixture.store.getRequest(fixture.candidate.requestKey)!;
    const request = fixture.store.submitRequest({ request: { ...source.request, sourceId: 'run:billing', sourceRunId: 'billing',
      workItemId: 'github:acme/api#43' }, evidence: source.evidence });
    const processed = fixture.store.completeRequest(request.key, { version: 1, warnings: [], candidates: [candidateProposalSchema.parse({
      ...fixture.candidate.proposal, targetRef: 'wiki:billing', title: 'Billing', statement: 'Billing needs review',
      payload: { subject: 'billing', rule: 'Review bills before payment', classification: 'fact' },
    })] });
    const candidate = fixture.store.getCandidate(processed.candidateIds[0]!)!;
    const validated = fixture.store.recordValidation(candidate.id, candidate.version, { candidateDigest: candidate.digest,
      evidenceDigest: candidate.evidenceDigest, validatorVersion: 'knowledge-v1', passed: true, results: ['independent billing validation'] });
    const billing = await prepareKnowledgePublication({ ...fixture.input, candidateId: validated.id, expectedVersion: validated.version });
    await publishLearningCandidate({ ...fixture.input, key: billing.key });
    for (const publication of [approval, billing]) {
      expect(await readPublishedKnowledge({ ...fixture.input, key: publication.key, applicability: { version: 'abc' } })).not.toBeNull();
    }
    const before = readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8');
    expect((await reconcileKnowledgePublications(fixture.input)).results.every(result => !result.withdrawal)).toBe(true);
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toBe(before);
    fixture.store.invalidateRequestSource(fixture.candidate.requestKey);
    expect((await reconcileKnowledgePublications(fixture.input)).blocked).toEqual([]);
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
    expect(await readPublishedKnowledge({ ...fixture.input, key: billing.key, applicability: { version: 'abc' } })).not.toBeNull();
  });

  it('reconciles committed publications after source invalidation and a real store restart', async () => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    fixture.store.invalidateRequestSource(fixture.candidate.requestKey);
    fixture.store.close();
    const restarted = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
    try {
      const input = { ...fixture.input, store: restarted };
      expect(await reconcileKnowledgePublications({ ...input, policy: { ...fixture.policy, scope: 'github:other/api' } }))
        .toEqual({ results: [], blocked: [] });
      expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('Approve before publishing');
      expect(await reconcileKnowledgePublications(input)).toMatchObject({ blocked: [], results: [
        { publication: { key: prepared.key, phase: 'committed' }, withdrawal: { status: 'withdrawn' } },
      ] });
      expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
      const versions = restarted.getCandidateVersions(fixture.candidate.id);
      expect((await reconcileKnowledgePublications(input)).results[0].withdrawal?.status).toBe('withdrawn');
      expect(restarted.getCandidateVersions(fixture.candidate.id)).toEqual(versions);
    } finally { restarted.close(); }
  });

  it('reports an unrecoverable publication receipt without silently losing the pending recovery', async () => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    unlinkSync(join(fixture.recoveryDirectory, prepared.key, 'plan.json'));
    expect(await reconcileKnowledgePublications(fixture.input)).toEqual({ results: [], blocked: [
      { key: prepared.key, code: 'publication_recovery_blocked' },
    ] });
    expect(fixture.store.getPublication(prepared.key)?.phase).toBe('prepared');
    expect(() => readFileSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
  });

  it('recovers a withdrawal intent hard link left by a real SIGKILL before temporary unlink', async () => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
    fixture.store.close();
    const script = join(fixture.root, 'receipt-kill.mjs');
    await build({ stdin: { contents: `
      import fs from 'node:fs';
      import { basename } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      import { CandidateStore } from './candidate-store.js';
      import { publishLearningCandidate } from './publication.js';
      const original = fs.linkSync;
      fs.linkSync = (source, target) => {
        original(source, target);
        if (basename(target) === 'withdrawal.json') process.kill(process.pid, 'SIGKILL');
      };
      syncBuiltinESMExports();
      const { ledgerFile, ...input } = JSON.parse(process.argv[2]);
      const store = new CandidateStore({ file: ledgerFile });
      await publishLearningCandidate({ ...input, store });
      store.close();
    `, resolveDir: fileURLToPath(new URL('.', import.meta.url)) }, outfile: script,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    const { store: _store, ...options } = fixture.input;
    const child = spawn(process.execPath, [script, JSON.stringify({ ...options, key: prepared.key, ledgerFile: join(fixture.root, 'ledger.sqlite') })],
      { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = await new Promise((resolveExit, reject) => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Receipt crash child timed out')); }, 10_000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal, stderr }); });
    });
    expect(exit).toEqual({ code: null, signal: 'SIGKILL', stderr: '' });
    const directory = join(fixture.recoveryDirectory, prepared.key);
    const intent = join(directory, 'withdrawal.json');
    expect(lstatSync(intent).nlink).toBe(2);
    const temporary = readdirSync(directory).find(name => name.startsWith('.receipt-'))!;
    expect(lstatSync(join(directory, temporary)).ino).toBe(lstatSync(intent).ino);
    const restarted = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
    try {
      const input = { ...fixture.input, store: restarted, key: prepared.key, applicability: { version: 'abc' } };
      expect((await publishLearningCandidate(input)).withdrawal?.status).toBe('withdrawn');
      expect(lstatSync(intent).nlink).toBe(1);
      expect(readdirSync(directory)).not.toContain(temporary);
      expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('knowledge_status: revoked');
      expect((await publishLearningCandidate(input)).withdrawal?.status).toBe('withdrawn');
    } finally { restarted.close(); }
  });

  it.each(['external', 'external-and-temporary', 'symbolic-temporary', 'symbolic-receipt'] as const)
    ('preserves protection for %s links on withdrawal receipts', async kind => {
      const fixture = open();
      const prepared = await prepareKnowledgePublication(fixture.input);
      const input = { ...fixture.input, key: prepared.key };
      await publishLearningCandidate(input);
      fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
      await publishLearningCandidate(input);
      const directory = join(fixture.recoveryDirectory, prepared.key);
      const intent = join(directory, 'withdrawal.json');
      const external = join(fixture.root, 'external-receipt.json');
      const temporary = join(directory, '.receipt-11111111-1111-4111-8111-111111111111');
      const original = readFileSync(intent, 'utf8');
      if (kind === 'symbolic-receipt') { renameSync(intent, external); symlinkSync(external, intent); }
      else {
        linkSync(intent, external);
        if (kind === 'external-and-temporary') linkSync(intent, temporary);
        if (kind === 'symbolic-temporary') symlinkSync(intent, temporary);
      }
      await expect(publishLearningCandidate(input)).rejects.toThrow(/private|regular|link/i);
      expect(readFileSync(external, 'utf8')).toBe(original);
      if (kind === 'external-and-temporary') expect(lstatSync(temporary).nlink).toBe(3);
      if (kind === 'symbolic-temporary') expect(lstatSync(temporary).isSymbolicLink()).toBe(true);
      if (kind === 'symbolic-receipt') expect(lstatSync(intent).isSymbolicLink()).toBe(true);
    });

  it.each([{ environments: ['production'] }, { environments: [] }])('enforces process environment and version constraints for $environments', async ({ environments: environment }) => {
    const fixture = open(candidateProposalSchema.parse({ ...output.candidates[0], kind: 'process', targetRef: 'wiki:approval', payload: {
      entry: 'Submit order', systems: ['API'], preconditions: ['Authenticated'],
      steps: [{ id: 'submit', action: 'Submit', stateChange: 'new → queued', evidenceIds: ['e1'] }],
      exceptions: ['Rejected'], completion: 'Order queued',
    }, applicability: { ...output.candidates[0]!.applicability, environments: environment } }));
    const prepared = await prepareKnowledgePublication(fixture.input);
    const input = { ...fixture.input, key: prepared.key };
    await publishLearningCandidate(input);
    const valid = { version: 'abc', ...(environment.length ? { environment: 'production' } : {}) };
    expect(await readPublishedKnowledge({ ...input, applicability: valid })).toMatchObject({ classification: 'process' });
    expect(await readPublishedKnowledge(input)).toBeNull();
    expect(await readPublishedKnowledge({ ...input, applicability: { environment: 'production' } })).toBeNull();
    expect(await readPublishedKnowledge({ ...input, applicability: { version: 'wrong', environment: 'production' } })).toBeNull();
    expect(await readPublishedKnowledge({ ...input, applicability: { version: '', environment: 'production' } })).toBeNull();
    if (environment.length) {
      expect(await readPublishedKnowledge({ ...input, applicability: { version: 'abc' } })).toBeNull();
      expect(await readPublishedKnowledge({ ...input, applicability: { version: 'abc', environment: 'staging' } })).toBeNull();
    } else {
      expect(await readPublishedKnowledge({ ...input, applicability: { version: 'abc', environment: 'staging' } })).not.toBeNull();
    }
  });
  it('reloads the persisted grant at prepare and apply rather than trusting the supplied policy', async () => {
    const fixture = open();
    fixture.persistGrant(true);
    await expect(prepareKnowledgePublication(fixture.input)).rejects.toThrow(/revoked|authorization/i);
    fixture.persistGrant();
    const prepared = await prepareKnowledgePublication(fixture.input);
    fixture.persistGrant(true);
    const result = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(result.publication.phase).toBe('conflict');
    expect(() => readFileSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
  });

  it('rejects forged, missing, public and symbolic persistent grants', async () => {
    const fixture = open();
    const forged = { ...fixture.policy, targets: [{ ...fixture.policy.targets[0]!, paths: ['知识/Forged.md'] }] };
    await expect(prepareKnowledgePublication({ ...fixture.input, policy: forged })).rejects.toThrow(/authorization/i);
    chmodSync(fixture.authorizationFile, 0o644);
    await expect(prepareKnowledgePublication(fixture.input)).rejects.toThrow(/private/i);
    chmodSync(fixture.authorizationFile, 0o600);
    const saved = readFileSync(fixture.authorizationFile);
    unlinkSync(fixture.authorizationFile);
    await expect(prepareKnowledgePublication(fixture.input)).rejects.toThrow();
    const other = join(fixture.root, 'other.json');
    writeFileSync(other, saved, { mode: 0o600 });
    symlinkSync(other, fixture.authorizationFile);
    await expect(prepareKnowledgePublication(fixture.input)).rejects.toThrow();
  });

  it.each(['source_invalidated', 'conflict', 'revoked'] as const)('rechecks %s after restart with externally applied but uncommitted knowledge', async invalidation => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    vi.spyOn(fixture.store, 'advancePublication').mockImplementation(() => { throw new Error('Crash before journal advancement'); });
    await expect(publishLearningCandidate({ ...fixture.input, key: prepared.key })).rejects.toThrow(/Crash/);
    vi.restoreAllMocks();
    fixture.store.close();
    const restarted = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
    try {
      if (invalidation === 'source_invalidated') restarted.setRequestBlocked(fixture.candidate.requestKey, invalidation);
      if (invalidation === 'conflict') restarted.transitionCandidate(fixture.candidate.id, fixture.candidate.version, 'conflict');
      if (invalidation === 'revoked') fixture.persistGrant(true);
      const input = { ...fixture.input, store: restarted, key: prepared.key, applicability: { version: 'abc' } };
      expect(await readPublishedKnowledge(input)).toBeNull();
      await expect(prepareKnowledgePublication(input)).rejects.toThrow(/invalidated|blocked|validation|revoked/i);
      const result = await publishLearningCandidate(input);
      expect(result).toMatchObject({ publication: { phase: 'conflict' }, withdrawal: { status: 'withdrawn' } });
      expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('Approve before publishing');
      expect(await readPublishedKnowledge(input)).toBeNull();
    } finally { restarted.close(); }
  });

  it('separates snapshot retrieval by exact environment and version and retains its applicability', async () => {
    const fixture = open(candidateProposalSchema.parse({ ...output.candidates[0], targetRef: 'wiki:approval',
      title: 'Production image', statement: 'Production currently runs image abc',
      payload: { subject: 'production image', rule: 'Production currently runs image abc', classification: 'fact' },
      applicability: { ...output.candidates[0]!.applicability, environments: ['production'], invalidationConditions: ['Image replaced'] } }));
    Object.assign(fixture.policy.targets[0]!, { snapshot: true, paths: ['环境/Production.md'] });
    fixture.persistGrant();
    const prepared = await prepareKnowledgePublication(fixture.input);
    const input = { ...fixture.input, key: prepared.key };
    await publishLearningCandidate(input);
    expect(await readPublishedKnowledge(input)).toBeNull();
    expect(await readPublishedKnowledge({ ...input, applicability: { version: 'abc', environment: 'staging' } })).toBeNull();
    expect(await readPublishedKnowledge({ ...input, applicability: { version: 'def', environment: 'production' } })).toBeNull();
    expect(await readPublishedKnowledge({ ...input, applicability: { version: 'abc', environment: 'production' } })).toBeNull();
    expect(await readPublishedKnowledge({ ...input, applicability: { version: 'abc', environment: 'production' },
      target: { project: fixture.policy.scope, conditions: { 'Image replaced': false } } }))
      .toMatchObject({ classification: 'snapshot', applicability: { environments: ['production'], invalidationConditions: ['Image replaced'] } });
    fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
    expect((await publishLearningCandidate(input)).withdrawal?.status).toBe('withdrawn');
  });
  it('uses existing prepare/advance receipts and idempotently commits without rewriting', async () => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    expect(prepared.phase).toBe('prepared');
    expect(prepared.recoveryRef).toBe(`wiki:${prepared.key}`);
    expect(await prepareKnowledgePublication(fixture.input)).toEqual(prepared);
    const input = { ...fixture.input, key: prepared.key };
    expect((await publishLearningCandidate(input)).publication.phase).toBe('committed');
    expect(await readPublishedKnowledge(input)).toBeNull();
    expect(await readPublishedKnowledge({ ...input, applicability: { version: 'abc' } })).toMatchObject({ classification: 'fact' });
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('published');
    expect(fixture.store.listUnfinishedPublications()).toEqual([]);
    const before = statSync(join(fixture.vault, '知识/Approval.md')).mtimeMs;
    expect((await publishLearningCandidate(input)).publication.phase).toBe('committed');
    expect(statSync(join(fixture.vault, '知识/Approval.md')).mtimeMs).toBe(before);
  });

  it.each(['applied', 'committed'] as const)('recovers after interruption before the %s journal update', async phase => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    const advance = fixture.store.advancePublication.bind(fixture.store);
    vi.spyOn(fixture.store, 'advancePublication').mockImplementation((key, next, observed) => {
      if (next === phase) throw new Error('Injected interruption');
      return advance(key, next, observed);
    });
    await expect(publishLearningCandidate({ ...fixture.input, key: prepared.key })).rejects.toThrow('Injected interruption');
    const before = statSync(join(fixture.vault, '知识/Approval.md')).mtimeMs;
    fixture.store.close();
    const restarted = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
    try {
      const result = await publishLearningCandidate({ ...fixture.input, store: restarted, key: prepared.key });
      expect(result.publication.phase).toBe('committed');
      expect(statSync(join(fixture.vault, '知识/Approval.md')).mtimeMs).toBe(before);
    } finally { restarted.close(); }
  });

  it('refuses third-party target changes during recovery and marks conflict', async () => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    fixture.write('知识/入口.md', page('入口', 'Third party edit'));
    const result = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(result.publication.phase).toBe('conflict');
    expect(fixture.store.getCandidate(fixture.candidate.id)?.state).toBe('conflict');
    expect(readFileSync(join(fixture.vault, '知识/入口.md'), 'utf8')).toContain('Third party edit');
    expect(() => readFileSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
  });

  it('reuses Python recovery receipts after a real partial write failure', async () => {
    const fixture = open();
    fixture.write('.tools/wiki-lint.py', `import argparse, json\nfrom pathlib import Path\nparser=argparse.ArgumentParser()\nparser.add_argument('--vault')\nparser.add_argument('--json', action='store_true')\nparser.add_argument('--max-age-days')\nargs=parser.parse_args()\nroot=Path(args.vault)\nmarker=Path(__file__).parent / 'fail-once'\nfindings=[]\nif (root / '知识/Approval.md').exists() and root == Path(${JSON.stringify(fixture.vault)}) and not marker.exists():\n    marker.write_text('failed')\n    findings=[dict(check='injected', level='error', file='知识/Approval.md', line=1, message='Injected post-write failure')]\nprint(json.dumps(dict(findings=findings)))\nraise SystemExit(bool(findings))\n`);
    const { hash } = await import('./knowledge.fixture.spec.js');
    fixture.policy.rules['.tools/wiki-lint.py'] = hash(readFileSync(join(fixture.vault, '.tools/wiki-lint.py')));
    fixture.persistGrant();
    const prepared = await prepareKnowledgePublication(fixture.input);
    const failed = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(failed.publication.phase).toBe('prepared');
    expect(failed.recovery).toBeDefined();
    const receipt = JSON.parse(readFileSync(join(failed.recovery!, 'recovery.json'), 'utf8'));
    expect(receipt.restored).toHaveLength(3);
    expect(receipt.unrestored).toEqual([]);
    expect(readdirSync(join(fixture.recoveryDirectory, prepared.key))).toContain('plan.json');
    expect((await publishLearningCandidate({ ...fixture.input, key: prepared.key })).publication.phase).toBe('committed');
  });

  it.each(['blocked', 'candidate'] as const)('blocks recovery after source/candidate invalidation: %s', async reason => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    if (reason === 'blocked') fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
    else fixture.store.transitionCandidate(fixture.candidate.id, fixture.candidate.version, 'conflict');
    expect((await publishLearningCandidate({ ...fixture.input, key: prepared.key })).publication.phase).toBe('conflict');
    expect(() => readFileSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
  });

  it('blocks prepare for withdrawn sources and withdraws content invalidated during apply', async () => {
    const denied = open();
    denied.store.setRequestBlocked(denied.candidate.requestKey, 'source_invalidated');
    await expect(prepareKnowledgePublication(denied.input)).rejects.toThrow(/source|blocked|invalidated/i);
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    const original = knowledge.runWikiIngest;
    vi.spyOn(knowledge, 'runWikiIngest').mockImplementation(async (...arguments_) => {
      const result = await original(...arguments_);
      fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
      return result;
    });
    const result = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(result).toMatchObject({ publication: { phase: 'conflict' }, wikiStatus: 'applied' });
    expect(result.withdrawal?.status).toBe('withdrawn');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('Approve before publishing');
    expect(await readPublishedKnowledge({ ...fixture.input, key: prepared.key, applicability: { version: 'abc' } })).toBeNull();
  });

  it('withdraws a committed publication with a version-bound durable outcome and preserves private history', async () => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
    expect(fixture.store.getCandidate(fixture.candidate.id)).toMatchObject({ state: 'conflict', version: fixture.candidate.version + 2 });
    const result = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(result.withdrawal).toMatchObject({ status: 'withdrawn', key: prepared.key,
      candidateVersion: prepared.candidateVersion, evidenceDigest: prepared.evidenceDigest });
    expect(fixture.store.getPublication(prepared.key)?.phase).toBe('committed');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('revoked');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).not.toContain('Approve before publishing');
    expect(readFileSync(join(fixture.recoveryDirectory, prepared.key, 'plan.json'), 'utf8')).toContain('Approve before publishing');
    expect((await publishLearningCandidate({ ...fixture.input, key: prepared.key })).withdrawal).toEqual(result.withdrawal);
    expect(await readPublishedKnowledge({ ...fixture.input, key: prepared.key, applicability: { version: 'abc' } })).toBeNull();
  });

  it('preserves a human edit made after a successful withdrawal and reports the new blocked outcome', async () => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    const input = { ...fixture.input, key: prepared.key, applicability: { version: 'abc' } };
    await publishLearningCandidate(input);
    fixture.persistGrant(true);
    expect((await publishLearningCandidate(input)).withdrawal?.status).toBe('withdrawn');
    fixture.write('知识/Approval.md', page('Approval', 'Human restored an independently verified rule'));
    expect((await publishLearningCandidate(input)).withdrawal?.status).toBe('rollback_blocked');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('Human restored');
    expect(await readPublishedKnowledge(input)).toBeNull();
  });

  it.each(['human', 'grant'] as const)('persists rollback_blocked and excludes retrieval when withdrawal is blocked by %s', async blocker => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    const input = { ...fixture.input, key: prepared.key, applicability: { version: 'abc' } };
    await publishLearningCandidate(input);
    expect(await readPublishedKnowledge(input)).not.toBeNull();
    fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
    if (blocker === 'human') fixture.write('知识/Approval.md', page('Approval', 'Human kept a corrected approval rule'));
    else fixture.persistGrant(true, false);
    const before = readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8');
    const result = await publishLearningCandidate(input);
    expect(result.withdrawal?.status).toBe('rollback_blocked');
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toBe(before);
    expect((await publishLearningCandidate(input)).withdrawal).toEqual(result.withdrawal);
    expect(await readPublishedKnowledge(input)).toBeNull();
  });

  it.each([false, true])('recovers a genuine Python withdrawal interruption without overwriting human edits = %s', async humanEdit => {
    const fixture = open();
    const prepared = await prepareKnowledgePublication(fixture.input);
    await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    fixture.store.setRequestBlocked(fixture.candidate.requestKey, 'source_invalidated');
    const script = join(fixture.root, 'withdraw-interrupt.py');
    const marker = join(fixture.root, 'withdraw-interrupted');
    writeFileSync(script, `import importlib.util, os\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('wiki', ${JSON.stringify(fixture.wikiScript)})\nwiki=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(wiki)\noriginal=wiki.replace_file\nmarker=Path(${JSON.stringify(marker)})\ndef interrupt(target, content, mode):\n    original(target, content, mode)\n    if not marker.exists():\n        marker.write_text('interrupted')\n        os._exit(73)\nwiki.replace_file=interrupt\nraise SystemExit(wiki.main())\n`);
    const input = { ...fixture.input, wikiScript: script, key: prepared.key, applicability: { version: 'abc' } };
    const first = await publishLearningCandidate(input);
    expect(first.withdrawal?.status).toBe('rollback_blocked');
    expect(first.withdrawal?.recovery).toBeDefined();
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('revoked');
    expect(await readPublishedKnowledge(input)).toBeNull();
    if (humanEdit) fixture.write('知识/Approval.md', page('Approval', 'Human corrected the withdrawn page'));
    fixture.store.close();
    const restarted = new CandidateStore({ file: join(fixture.root, 'ledger.sqlite') });
    try {
      const result = await publishLearningCandidate({ ...input, store: restarted });
      expect(result.withdrawal?.status).toBe(humanEdit ? 'rollback_blocked' : 'withdrawn');
      if (humanEdit) expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('Human corrected');
      expect(await readPublishedKnowledge({ ...input, store: restarted })).toBeNull();
    } finally { restarted.close(); }
  });

  it.each([false, true])('handles a genuinely interrupted Python batch with third-party edit = %s', async thirdParty => {
    const fixture = open();
    const script = join(fixture.root, 'interrupt.py');
    const marker = join(fixture.root, 'interrupted');
    writeFileSync(script, `import importlib.util, os, sys\nfrom pathlib import Path\nspec=importlib.util.spec_from_file_location('wiki', ${JSON.stringify(fixture.wikiScript)})\nwiki=importlib.util.module_from_spec(spec)\nspec.loader.exec_module(wiki)\noriginal=wiki.replace_file\nmarker=Path(${JSON.stringify(marker)})\ndef interrupt(target, content, mode):\n    original(target, content, mode)\n    if not marker.exists():\n        marker.write_text('interrupted')\n        os._exit(73)\nwiki.replace_file=interrupt\nraise SystemExit(wiki.main())\n`);
    const input = { ...fixture.input, wikiScript: script };
    const prepared = await prepareKnowledgePublication(input);
    const failed = await publishLearningCandidate({ ...input, key: prepared.key });
    expect(failed.publication.phase).toBe('prepared');
    expect(failed.recovery).toBeDefined();
    expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('Approve before publishing');
    expect(readFileSync(join(fixture.vault, '00-总览.md'), 'utf8')).not.toContain('[[知识/Approval]]');
    const directory = join(fixture.recoveryDirectory, prepared.key);
    const recovery = readdirSync(directory).find(name => name.startsWith('wiki-recovery-'))!;
    expect(JSON.parse(readFileSync(join(directory, recovery, 'recovery.json'), 'utf8')).changes).toHaveLength(3);
    if (thirdParty) {
      fixture.write('知识/Approval.md', page('Approval', 'Human changed the partially applied page'));
      expect((await publishLearningCandidate({ ...input, key: prepared.key })).publication.phase).toBe('conflict');
      expect(readFileSync(join(fixture.vault, '知识/Approval.md'), 'utf8')).toContain('Human changed');
      return;
    }
    expect((await publishLearningCandidate({ ...input, key: prepared.key })).publication.phase).toBe('committed');
  });

  it('rejects a concurrent edit inside the real Python ingest before any page replacement', async () => {
    const fixture = open();
    const trigger = join(fixture.root, 'concurrent');
    fixture.write('.tools/wiki-lint.py', `import argparse, json\nfrom pathlib import Path\nparser=argparse.ArgumentParser()\nparser.add_argument('--vault')\nparser.add_argument('--json', action='store_true')\nparser.add_argument('--max-age-days')\nargs=parser.parse_args()\nroot=Path(args.vault)\ntrigger=Path(${JSON.stringify(trigger)})\nif trigger.exists() and root == Path(${JSON.stringify(fixture.vault)}):\n    trigger.unlink()\n    (root / '知识/入口.md').write_text(${JSON.stringify(page('入口', 'Concurrent human edit'))}, encoding='utf-8')\nprint(json.dumps(dict(findings=[])))\n`);
    const { hash } = await import('./knowledge.fixture.spec.js');
    fixture.policy.rules['.tools/wiki-lint.py'] = hash(readFileSync(join(fixture.vault, '.tools/wiki-lint.py')));
    fixture.persistGrant();
    const prepared = await prepareKnowledgePublication(fixture.input);
    writeFileSync(trigger, 'edit during ingest');
    const result = await publishLearningCandidate({ ...fixture.input, key: prepared.key });
    expect(result).toMatchObject({ publication: { phase: 'conflict' }, errorCode: 3 });
    expect(readFileSync(join(fixture.vault, '知识/入口.md'), 'utf8')).toContain('Concurrent human edit');
    expect(() => readFileSync(join(fixture.vault, '知识/Approval.md'))).toThrow();
  });
});
