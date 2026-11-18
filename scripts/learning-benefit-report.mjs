import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';

const protocol = 'w11-benefit-v1';
const scenarios = {
  environment: { prompt: '在 staging 快照中定位指定包裹的运行日志并返回对应记录。', detour: '在其他环境查找该记录' },
  process: { prompt: '按 staging 的非自提退件流程办理指定包裹的交接，给出签收记录。', detour: '未核对袋号就登记签收' },
  repair: { prompt: '修复指定面单的纵向偏移，使用同一标签验证修复结果。', detour: '走纸刻度错误时反复调整模板留白' },
};
const arms = ['none', 'old', 'new'];
const counts = ['steps', 'humanCorrections', 'durationMs', 'inputTokens', 'outputTokens', 'totalTokens'];
const measures = ['success', 'recurrence', ...counts, 'totalCostUSD'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function planTemplate() {
  return { protocol, scope: 'github:w11/parcel', scenarios: Object.fromEntries(Object.entries(scenarios).map(([name, task]) => [name, {
    ...task, parameters: ['W11-101', 'W11-202'], controls: null, failureEvidence: null, old: null, new: null,
  }])) };
}

const help = `node scripts/learning-benefit-report.mjs --plan > plan.json
Before collection, set scope to the actual project and fill each scenario's controls (identifier of the frozen snapshot, build, agent/model, budget and scoring setup), failureEvidence (saved original detour), old and new. Archive the plan before running. Use fresh tasks/sessions, the same prompt and repeat's parameter across all three arms. Keep all attempts, including failures.
An asset is exactly {experienceId,verificationDigest} or {candidateId,validatedVersion} from publication/installation evidence. none requires explicit null. Use the same identity scheme for both editions.
node scripts/learning-benefit-report.mjs plan.json observations.json
observations.json is an array, initially []. Each record has scenario, arm, repeat (1 or 2), prompt, parameter, controls (actual setup identifier), source:{workItemId,runId}, asset, evidence (locator of the run/setup record). Supply the measured asset assignment even when it was never selected. Differences in controls prevent paired scoring.
Copy nativeSessionId from the agent's session record. Omit it when unavailable. Runs with an unknown session retain their measurements, and paired gains require two distinct recorded sessions.
Optional fields include outcome (succeeded/failed/cancelled), taskCheck:{passed,evidence} from the frozen task check, recurrence (observed frozen detour anywhere in run), steps (executed task actions), humanCorrections (human interventions), durationMs (wall time from run start to terminal event), usage:{inputTokens,outputTokens,totalTokens}, and totalCostUSD. Use whole-run measurements. Omit unavailable fields or use null. Success is measured from taskCheck.passed.
Optionally include outcomes (the exact afk experience outcomes --json array for this task/run) and adoption (the afk experience adopt result with receipt). Keep only the assigned asset in the isolated profile. Positive event recurrence counts; a negative per-event flag alone cannot rule out a detour elsewhere. Selection and adoption do not establish benefit.
JSON output lists 18 slots, known metric counts and paired gains. Positive means better; null means missing or incomparable. Results describe only these runs.`;

function assetKind(asset) {
  assert.ok(asset && typeof asset === 'object' && Object.keys(asset).length === 2, 'expected a version-bound asset');
  if (text(asset.experienceId) && digest(asset.verificationDigest)) return 'experience';
  assert.ok(digest(asset.candidateId) && Number.isSafeInteger(asset.validatedVersion) && asset.validatedVersion > 0, 'invalid asset identity/version');
  return 'publication';
}

function observe(record, expected, scope) {
  const { source, asset, evidence, controls } = record;
  const nativeSessionId = record.nativeSessionId ?? null;
  assert.ok(nativeSessionId === null || (text(nativeSessionId) && nativeSessionId === nativeSessionId.trim()), 'invalid native session');
  const task = typeof source?.workItemId === 'string' && /^([^#]+)#([1-9]\d*)$/.exec(source.workItemId);
  assert.ok(text(source?.runId) && task && task[1] === scope && Number.isSafeInteger(Number(task[2])), 'invalid source.runId/workItemId');
  assert.ok(text(evidence) && text(controls), 'missing evidence or controls');
  assert.equal(record.prompt, expected.prompt, 'different task prompt');
  assert.equal(record.parameter, expected.parameters[record.repeat - 1], 'different task parameter');
  assert.deepEqual(asset, record.arm === 'none' ? null : expected[record.arm], 'wrong assigned asset');
  if (record.arm !== 'none') assetKind(asset);

  function checkBinding(binding) {
    assert.ok(asset, 'unexpected asset receipt in no-asset arm');
    assert.deepEqual(binding.source, source, 'wrong receipt task/run');
    assert.equal(binding.scope, scope, 'wrong receipt scope');
    const observed = assetKind(asset) === 'experience'
      ? { experienceId: binding.experienceId, verificationDigest: binding.verificationDigest }
      : { candidateId: binding.publication?.candidateId, validatedVersion: binding.publication?.validatedVersion };
    assert.deepEqual(observed, asset, 'wrong receipt asset/version');
  }

  let outcome = record.outcome ?? null;
  let recurrence = record.recurrence ?? null;
  assert.ok([null, 'succeeded', 'failed', 'cancelled'].includes(outcome), 'invalid outcome');
  assert.ok(recurrence === null || typeof recurrence === 'boolean', 'invalid recurrence');
  const receipts = record.outcomes ?? [];
  assert.ok(Array.isArray(receipts), 'expected outcomes array');
  for (const receipt of receipts) {
    assert.ok(receipt.version === 1 && receipt.stage === 'outcome' && receipt.selected?.stage === 'selected' && receipt.benefit === 'unknown', 'invalid outcome receipt');
    checkBinding(receipt.selected);
    const { event } = receipt;
    assert.equal(event.runId, source.runId, 'wrong event run');
    assert.ok(typeof receipt.recurrence === 'boolean' && ['run.finished', 'qa.failed', 'failure.classified'].includes(event.type), 'invalid outcome event');
    assert.ok(event.type === 'run.finished' ? ['succeeded', 'failed', 'cancelled'].includes(event.outcome) : event.outcome === 'failed', 'invalid event outcome');
    if (event.type === 'run.finished') {
      assert.ok(outcome === null || outcome === event.outcome, 'conflicting terminal outcome');
      outcome = event.outcome;
    }
    if (receipt.recurrence) {
      assert.notEqual(recurrence, false, 'conflicting recurrence');
      recurrence = true;
    }
  }
  if (record.adoption != null) {
    const binding = record.adoption.receipt;
    assert.equal(binding?.binding, 'verified-version', 'unbound adoption receipt');
    checkBinding(binding);
  }
  const usage = record.usage ?? {};
  assert.ok(typeof usage === 'object' && !Array.isArray(usage), 'invalid usage');
  const taskCheck = record.taskCheck ?? null;
  assert.ok(taskCheck === null || (typeof taskCheck.passed === 'boolean' && text(taskCheck.evidence)), 'invalid task check');
  const metrics = { success: taskCheck?.passed ?? null, recurrence };
  for (const key of counts) {
    const value = (key.endsWith('Tokens') ? usage[key] : record[key]) ?? null;
    assert.ok(value === null || (Number.isSafeInteger(value) && value >= 0), `invalid ${key}`);
    metrics[key] = value;
  }
  const cost = record.totalCostUSD ?? null;
  assert.ok(cost === null || (Number.isFinite(cost) && cost >= 0), 'invalid totalCostUSD');
  return { source, evidence, asset, controls, nativeSessionId, matchedControls: controls === expected.controls, outcome, taskCheck,
    outcomeReceipts: receipts.length, adoptionAcknowledged: record.adoption == null ? null : true, metrics: { ...metrics, totalCostUSD: cost } };
}

export function report(plan, records) {
  assert.ok(plan.protocol === protocol && typeof plan.scope === 'string' && /^(github|gitlab):[^\s#]+$/.test(plan.scope) && Array.isArray(records), 'invalid W11 inputs');
  const rows = [];
  const pairs = [];
  const runs = new Set();
  const tasks = new Set();
  const sessions = new Set();
  for (const [scenario, frozen] of Object.entries(planTemplate().scenarios)) {
    const setup = plan.scenarios[scenario];
    for (const key of ['prompt', 'detour', 'parameters']) assert.deepEqual(setup[key], frozen[key], `changed frozen ${scenario} ${key}`);
    const hasRecords = records.some(record => record.scenario === scenario);
    if (hasRecords) {
      assert.ok(text(setup.controls) && text(setup.failureEvidence), 'missing frozen controls or original failure evidence');
    }
    if (setup.old != null && setup.new != null) assert.ok(assetKind(setup.old) === assetKind(setup.new) &&
      !isDeepStrictEqual(setup.old, setup.new) && (!setup.old.verificationDigest || setup.old.verificationDigest !== setup.new.verificationDigest), 'expected distinct old/new asset bindings');
    for (const repeat of [1, 2]) {
      const block = {};
      for (const arm of arms) {
        const matches = records.filter(record => record.scenario === scenario && record.repeat === repeat && record.arm === arm);
        assert.ok(matches.length <= 1, `duplicate slot ${scenario}/${repeat}/${arm}`);
        const observed = matches.length ? observe(matches[0], setup, plan.scope) : null;
        if (observed) {
          const { runId, workItemId } = observed.source;
          assert.ok(!runs.has(runId) && !tasks.has(workItemId), 'reused run or work item');
          runs.add(runId);
          tasks.add(workItemId);
          if (observed.nativeSessionId !== null) {
            assert.ok(!sessions.has(observed.nativeSessionId), 'reused native session');
            sessions.add(observed.nativeSessionId);
          }
        }
        rows.push({ scenario, repeat, arm, observed });
        block[arm] = observed;
      }
      for (const [baseline, candidate] of [['none', 'old'], ['none', 'new'], ['old', 'new']]) {
        const before = block[baseline];
        const after = block[candidate];
        const gain = Object.fromEntries(measures.map(key => {
          const comparable = before?.matchedControls && after?.matchedControls && before.nativeSessionId && after.nativeSessionId
            && before.metrics[key] !== null && after.metrics[key] !== null;
          return [key, comparable ? (after.metrics[key] - before.metrics[key]) * (key === 'success' ? 1 : -1) : null];
        }));
        pairs.push({ scenario, repeat, baseline, candidate, gain });
      }
    }
  }
  assert.equal(runs.size, records.length, 'unknown scenario, repeat or arm');
  const known = Object.fromEntries(measures.map(key => [key, rows.filter(row => row.observed?.metrics[key] != null).length]));
  return { plan, expected: rows.length, recorded: runs.size, missing: rows.length - runs.size, known, rows, pairs,
    interpretation: 'Paired descriptive gains only. Two planned repeats per arm do not establish causality. Missing values and negative gains are retained.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  try {
    if (args.length === 1 && args[0] === '--help') console.log(help);
    else if (args.length === 1 && args[0] === '--plan') console.log(JSON.stringify(planTemplate(), null, 2));
    else {
      assert.equal(args.length, 2, 'expected plan.json observations.json (see --help)');
      console.log(JSON.stringify(report(...args.map(file => JSON.parse(readFileSync(file, 'utf8')))), null, 2));
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
