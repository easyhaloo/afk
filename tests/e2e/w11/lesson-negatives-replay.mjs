import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const root = realpathSync(process.argv[2]);
const raw = name => readFileSync(join(root, name), 'utf8');
const read = name => JSON.parse(raw(name));
const hash = content => createHash('sha256').update(content).digest('hex');
assert.equal(hash(raw('recall-v1.ts')), 'fd8f3c385505397735a46269e17db7a1d016ca3cae15911d6aa374cc6e0a05bb');
const { recallCases, assertObservedRecall } = await import(join(root, 'recall-v1.ts'));
const frozen = id => recallCases.find(row => row.id === id);
const { publication } = read('source/published.json');
const [authorized] = read('source/verified.json');
const install = read('source/installed.json');
assert.equal(install.releaseDigest, hash(raw('source/installed-release.json')));
const source = read('source/source.json');
const [candidate] = read('source/extraction.json').candidates;
const claude = read('source/claude-output.json');
assert.ok(claude.sessionId);
assert.deepEqual(claude.output.distillation.candidates[0], candidate.proposal);
assert.equal(candidate.requestKey, source.requestKey);
assert.equal(candidate.id, publication.candidateId);
assert.equal(candidate.digest, publication.candidateDigest);
assert.equal(publication.evidenceDigest, source.snapshot.digest);
assert.equal(publication.phase, 'committed');
const validation = read('source/validation.json');
const chunks = read('source/validation-chunks.json');
assert.ok(chunks.every(chunk => chunk.startsWith('json-base64-v1:')));
const signed = JSON.parse(Buffer.from(chunks.map(chunk => chunk.slice('json-base64-v1:'.length)).join(''), 'base64'));
assert.equal(signed.receiptDigest, validation.receiptDigest);
assert.equal(validation.status, 'validated');
assert.equal(validation.candidateId, candidate.id);
assert.equal(validation.validatedVersion, publication.candidateVersion);
assert.equal(publication.validatorVersion, `learning-validation-v1:${validation.executionId}`);
const qa = read('source/qa-binding.json');
assert.equal(qa.workItemId, source.workItemId);
assert.equal(authorized.source.runId, source.source.runId);
assert.equal(qa.qaRun, authorized.verifiedEvidence.runId);
assert.notEqual(qa.qaRun, source.source.runId);
assert.equal(hash(raw(`source/events/${Buffer.from(qa.qaRun).toString('base64url')}.jsonl`)), qa.qaDigest);
const historical = read('source/711/adoption.json').receipt;
assert.equal(historical.experienceId, authorized.id);
assert.deepEqual(historical.publication, authorized.publication);
const profiles = new Set();
const pids = new Set();
for (const id of ['lesson-03', 'lesson-04', 'lesson-05', 'lesson-06']) {
  const entry = frozen(id);
  const profile = read(`${id}/observed.receipt.json`).cwd;
  assert.equal(basename(profile), id);
  assert.ok(!profiles.has(profile));
  profiles.add(profile);
  let lastFinished = 0;
  function receipt(name) {
    const result = read(`${id}/${name}.receipt.json`);
    assert.equal(result.status, 0);
    assert.equal(result.signal, null);
    assert.ok(result.pid > 0 && !pids.has(result.pid));
    pids.add(result.pid);
    assert.ok(Date.parse(result.started) >= lastFinished);
    lastFinished = Date.parse(result.finished);
    assert.ok(lastFinished >= Date.parse(result.started));
    if (name !== 'reconcile') {
      assert.equal(result.cwd, profile);
      assert.equal(result.env.HOME, profile);
      assert.equal(result.env.AFK_EVENT_STORE_DIR, join(profile, 'events'));
    }
    return result;
  }
  function gather(name, queryId) {
    const result = receipt(name);
    const filename = `${name}.input.json`;
    assert.deepEqual(result.argv.slice(0, 7), [install.binary, 'plugin', 'invoke', 'context.provider', 'context.experience', 'gather', '--input']);
    assert.equal(result.argv.length, 9);
    assert.equal(result.argv[8], '--json');
    assert.ok(result.argv[7].endsWith(`/${id}/${filename}`));
    assert.deepEqual(read(`${id}/${filename}`), frozen(queryId).query);
    return JSON.parse(result.stdout);
  }
  function list(name) {
    const result = receipt(name);
    assert.deepEqual(result.argv, [install.binary, 'experience', 'list', '--scope', entry.query.scope, '--json']);
    return JSON.parse(result.stdout);
  }
  let positive;
  if (id === 'lesson-06') {
    assert.deepEqual(read(`${id}/initial.json`), { profile, entries: [], missing: [
      ['candidates.sqlite', 'ENOENT'], ['experience.sqlite', 'ENOENT'],
    ] });
  } else {
    const project = receipt('project');
    assert.deepEqual(project.argv.slice(-8), [install.binary, 'experience', 'knowledge', 'publish', publication.key, '--scope', entry.query.scope, '--json']);
    assert.deepEqual(JSON.parse(project.stdout), { publication, experienceProjection: { blocked: [] } });
    const records = list('list-before');
    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.status, 'verified');
    assert.deepEqual(record.publication, authorized.publication);
    assert.equal(record.publication.key, publication.key);
    assert.equal(record.publication.validatedVersion, entry.asset.edition);
    assert.equal(record.publication.targetRef, `wiki:${entry.asset.key}`);
    assert.equal(record.scope, entry.asset.scope);
    assert.deepEqual(record.source, authorized.source);
    assert.equal(record.verifiedEvidence.runId, qa.qaRun);
    positive = gather('positive', 'lesson-01');
    assert.equal(positive.length, 1);
    assert.equal(positive[0].origin, `experience:${record.id}; verification:run:${qa.qaRun}; expires:${record.expiresAt}`);
    assert.ok(positive[0].content.includes(record.action));
  }
  if (id === 'lesson-05') {
    const call = receipt('reconcile');
    const grant = read(`${id}/grant-before.json`);
    assert.deepEqual(grant, read('source/grant.json'));
    assert.equal(grant.revoked, false);
    assert.equal(grant.allowWithdrawal, true);
    assert.deepEqual(read(`${id}/grant-after.json`), { ...grant, revoked: true });
    assert.deepEqual(read(`${id}/source-grant-after.json`), grant);
    assert.equal(call.executable, 'docker');
    assert.ok(call.argv.includes(`${profile}:${dirname(grant.policy.vault)}`));
    assert.ok(call.argv.includes(`${dirname(dirname(install.binary))}:/release:ro`));
    assert.deepEqual(call.argv.slice(-7), ['/release/dist/index.js', 'experience', 'knowledge', 'reconcile', '--scope', entry.query.scope, '--json']);
    const result = JSON.parse(call.stdout);
    assert.deepEqual(result.blocked, []);
    assert.equal(result.results.length, 1);
    const [item] = result.results;
    assert.deepEqual(item.publication, publication);
    assert.deepEqual(item.withdrawal, read(`${id}/withdrawal-result.json`));
    assert.equal(item.withdrawal.status, 'withdrawn');
    const intent = read(`${id}/withdrawal.json`);
    for (const field of ['key', 'candidateVersion', 'candidateDigest', 'evidenceDigest']) {
      assert.equal(item.withdrawal[field], publication[field]);
      assert.equal(intent[field], publication[field]);
    }
    const before = raw(`${id}/page-before.md`);
    const after = raw(`${id}/page-after.md`);
    assert.equal(before, raw('source/Label.md'));
    assert.equal(before, raw(`${id}/source-page-after.md`));
    assert.deepEqual(intent.plan.changes, [{ path: 'Label.md', expected_sha256: hash(before), content: after }]);
    assert.match(after, /^knowledge_status: revoked$/m);
    assert.equal(item.withdrawal.observedDigest, hash(JSON.stringify([{ path: 'Label.md', sha256: hash(after) }])));
    assert.deepEqual(gather('alias-after', 'lesson-02'), []);
  }
  const ranked = gather('observed', id);
  assertObservedRecall(entry, { caseId: id, status: 'observed', ranked });
  const remaining = list('list-after');
  if (id === 'lesson-06') assert.deepEqual(remaining, []);
  if (entry.state === 'active') assert.deepEqual(gather('positive-after', 'lesson-01'), positive);
  console.log(JSON.stringify({ id, state: entry.state, prompt: entry.query.prompt, ranked }));
}
