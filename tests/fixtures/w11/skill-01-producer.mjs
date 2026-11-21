import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [runtime, directory, mode, priorReview] = process.argv.slice(2);
const load = name => import(pathToFileURL(join(runtime, `${name}.js`)).href);
const { queryLearningState, LearningWorker, executeAnalysis, parseAnalysisOutput, reconcileDistillationSources, submitLearningCorrection } = await load('execution');
const { CandidateStore } = await load('application/learning/candidate-store');
const { ClaudeCodeProvider } = await load('domain/agents/claude-code');
const { JsonlEventStore } = await load('infrastructure/observability/jsonl-event-store');
const { prepareAssetProposal } = await load('application/learning/proposals');
const { scope, key, revisions } = JSON.parse(await readFile(join(directory, 'historical.json')));
const eventRoot = join(directory, 'producer-events');
const events = new JsonlEventStore({ root: eventRoot });
const runId = 'parcel-skill-review';
const workItemId = `${scope}#41`;
const manifest = ['S-18','S-33'];
const scanned = ['S-18','S-90'];
const diff = { missing: manifest.filter(bag => !scanned.includes(bag)), extra: scanned.filter(bag => !manifest.includes(bag)) };
assert.deepEqual(diff, { missing: ['S-33'], extra: ['S-90'] });
const summary = JSON.stringify({ review: '封袋对账技能改进评审。旧技能只要求报告差异，未区分漏登和多扫。只读核对须按类别逐个报告袋号；输入缺页请求补齐，无授权拒绝读取。',
  originalSkill: `skill:${key}`, originalDigest: revisions[0], project: scope, product: 'parcel', version: '2.0', environment: 'staging', manifest, scanned, observed: diff });
const entries = [{ kind: 'qa.started' }, { kind: 'effect.completed', effectKind: 'parcel.bag-reconciliation', idempotencyKey: runId, outcome: 'succeeded', summary },
  { kind: 'qa.passed' }, { kind: 'run.finished', outcome: 'succeeded' }];
function reconcile(authorized, complete, readHandoff) {
  if (!authorized) return 'refuse-before-read';
  if (!complete) return 'request-missing-page';
  const { manifest, scanned } = readHandoff();
  return { missing: manifest.filter(bag => !scanned.includes(bag)), extra: scanned.filter(bag => !manifest.includes(bag)) };
}
const cases = [
  { input: '有权读取的完整交接单', result: reconcile(true, true, () => ({ manifest, scanned })) },
  { input: '交接单第二页缺失', result: reconcile(true, false, assert.fail) },
  { input: '操作员无交接单读取权限', result: reconcile(false, true, assert.fail) },
];
entries.splice(2, 0, { kind: 'effect.completed', effectKind: 'parcel.skill-amendment-review', idempotencyKey: `${runId}-review`, outcome: 'succeeded',
  summary: JSON.stringify({ deliverable: '既有封袋对账 SKILL.md 的候审修订补丁', skill: `skill:${key}`, originalDigest: revisions[0],
    triggers: ['封袋对账', '袋单核对'], before: await readFile(join(directory, 'source', key, 'SKILL.md'), 'utf8'), testedImplementation: reconcile.toString(), cases }) });
const store = join(directory, 'producer-ledger');
let requestKey;
if (mode !== 'read-only') {
  if (priorReview) {
    const prior = JSON.parse(await readFile(join(priorReview, 'extraction.json')));
    const rejected = prior.candidates.find(candidate => candidate.proposal.kind === 'skill');
    assert.equal(rejected.proposal.payload.prohibitedConditions.length, 0);
    const gate = await readFile(join(priorReview, 'test.log'), 'utf8');
    assert.ok(gate.includes('Skill requires parameters, branches, recovery and prohibited conditions'));
    entries.splice(-2, 0, { kind: 'effect.completed', effectKind: 'parcel.proposal-feedback', idempotencyKey: `${runId}-gate`, outcome: 'succeeded',
      summary: JSON.stringify({ priorCandidate: rejected.id, rejectedBy: 'prepareAssetProposal',
        finding: '草稿把权限拒绝记录到了恢复步骤，遗漏了禁止条件。无交接单读取权限时禁止读取，禁止修改原单。',
        observedRefusal: cases[2], scope, skill: `skill:${key}`, originalDigest: revisions[0], reviewedPatch: rejected.proposal.payload.patch }) });
  }
  if (mode === 'correct') {
    const rejected = queryLearningState({ directory: store, scope }).candidates.find(candidate => candidate.proposal.kind === 'skill');
    const correction = '封袋对账技能提案复核：原稿正确描述了漏扫、多扫、缺页恢复和拒绝行为，但禁止条件为空，未通过提案准备。请修订原稿，明确未获授权禁止读取交接单，始终只读。保留原稿已通过业务检查的部分，以及原摘要和适用范围。修订只提交人工审阅。';
    const submitted = await submitLearningCorrection({ directory: store, scope, sourceId: `candidate:${rejected.id}`, correction,
      target: { candidateId: rejected.id, expectedVersion: rejected.version } });
    requestKey = submitted.key;
    await writeFile(join(directory, 'correction.json'), JSON.stringify({ candidateId: rejected.id, version: rejected.version, requestKey, correction }, null, 2));
  } else {
    await events.append(entries.map((data, index) => ({ id: `${data.kind}-${index}`, type: data.kind, schemaVersion: 1, occurredAt: new Date().toISOString(), correlationId: runId,
      context: { traceId: runId, runId, workItemId, profileId: 'fixture', attempt: 1, actor: { kind: 'system', id: 'parcel-check' } }, data })));
    const capture = await reconcileDistillationSources({ directory: store, eventRoot, homeDir: directory, scope, workItemId, runId });
    assert.equal(capture.submitted, 1);
    [requestKey] = capture.requestKeys;
  }
  const target = { scope, requestKey };
  const ledger = new CandidateStore({ file: join(store, 'candidates.sqlite') });
  const { request } = ledger.getRequest(target.requestKey);
  const snapshot = ledger.getEvidencePack(request.evidenceDigest);
  ledger.close();
  const worker = new LearningWorker({ directory: store, enabled: true, dailyCalls: mode === 'correct' ? 2 : 1, provider: new ClaudeCodeProvider(), analyze: async input => {
    const result = await executeAnalysis(input);
    await writeFile(join(directory, 'analysis-output.json'), JSON.stringify(result.output, null, 2));
    try { parseAnalysisOutput(result.output, request, snapshot); } catch (error) { console.error(error.message); }
    return result;
  } });
  try { await worker.runOnce(target); } finally { await worker.close(); }
}
const state = queryLearningState({ directory: store, scope });
const job = requestKey ? state.jobs.find(job => job.jobId === requestKey) : state.jobs.at(-1);
const candidates = state.candidates.filter(candidate => candidate.requestKey === job.jobId);
await writeFile(join(directory, 'extraction.json'), JSON.stringify({ job, candidates, diff }, null, 2));
assert.equal(job.status, 'processed');
assert.equal(job.attempts.length, 1);
const skill = candidates.find(item => item.proposal.kind === 'skill' && item.proposal.payload.targetSkill === `skill:${key}`);
assert.ok(skill, 'No candidate for the original installed skill');
const file = join(directory, 'source', key, 'SKILL.md');
const prepared = prepareAssetProposal(skill.proposal, { skills: [{ name: key, description: '封袋对账（袋单核对）技能比对交接单和袋号，只读输出差异。',
  'disable-model-invocation': false, 'user-invocable': true, 'allowed-tools': ['Read'], 'disallowed-tools': ['Bash', 'Write'],
  source: { root: join(directory, 'source'), file } }], tools: [], toolSearches: ['cli','script','plugin'] });
assert.equal(prepared.execution.autoInstall, false);
await writeFile(join(directory, 'proposal.json'), JSON.stringify({ candidateId: skill.id, evidenceDigest: skill.evidenceDigest, ...prepared }, null, 2));
