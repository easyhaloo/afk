import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { planTemplate, report } from './learning-benefit-report.mjs';

function fixture() {
  const plan = planTemplate();
  const setup = plan.scenarios.repair;
  const experienceId = 'b9871bb1-4e18-45b2-9cf0-31627fa239c5';
  Object.assign(setup, { controls: 'fixture-snapshot', failureEvidence: 'fixture/original-failure',
    old: { experienceId, verificationDigest: 'a'.repeat(64) }, new: { experienceId, verificationDigest: 'b'.repeat(64) } });
  const row = (arm, id) => ({ scenario: 'repair', repeat: 1, arm, prompt: setup.prompt, parameter: setup.parameters[0],
    controls: setup.controls, nativeSessionId: `native-${id}`, source: { workItemId: `${plan.scope}#${id}`, runId: `fixture-${id}` },
    asset: setup[arm] ?? null, evidence: `fixture/run-${id}` });
  const baseline = { ...row('none', 1), outcome: 'succeeded', taskCheck: { passed: true, evidence: 'fixture/check-1' }, recurrence: false, steps: 3, durationMs: 40, totalCostUSD: 0 };
  const current = { ...row('new', 2), steps: 5, humanCorrections: 0, durationMs: 55, usage: { inputTokens: 0 } };
  const time = '2026-11-18T00:00:00.000Z';
  const selected = { version: 1, stage: 'selected', selectionId: 'ef458de0-3f98-40d5-8a95-70e8b6b4685f', scope: plan.scope,
    source: current.source, ...current.asset, contextDigest: 'c'.repeat(64), fragmentDigest: 'd'.repeat(64),
    retrievedFragmentDigest: 'e'.repeat(64), recordedAt: time };
  const receipt = { version: 1, stage: 'outcome', selected, benefit: 'unknown', recurrence: true,
    event: { runId: current.source.runId, sequence: 8, hash: 'f'.repeat(64), type: 'qa.failed', outcome: 'failed',
      occurredAt: '2026-11-18T00:01:00.000Z', observedAt: '2026-11-18T00:01:00.000Z' }, recordedAt: '2026-11-18T00:01:00.000Z' };
  current.outcomes = [receipt];
  return { plan, baseline, current, receipt };
}

test('CLI empty ledger exposes all 18 pending slots and no measured gains', t => {
  const dir = mkdtempSync(join(tmpdir(), 'w11-benefit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('./learning-benefit-report.mjs', import.meta.url));
  const cli = (...args) => execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', cwd: dir });
  writeFileSync(join(dir, 'plan.json'), cli('--plan'));
  writeFileSync(join(dir, 'observations.json'), '[]');
  const result = JSON.parse(cli('plan.json', 'observations.json'));
  assert.deepEqual([result.expected, result.recorded, result.missing], [18, 0, 18]);
  assert.equal(new Set(result.rows.map(row => `${row.scenario}/${row.repeat}/${row.arm}`)).size, 18);
  assert.ok(result.rows.every(row => row.observed === null));
  assert.ok(result.pairs.every(pair => Object.values(pair.gain).every(value => value === null)));
});

test('pairs same task and repeat, keeps negative gains, partial receipts and unknown usage', () => {
  const { plan, baseline, current, receipt } = fixture();
  const result = report(plan, [baseline, current]);
  const observed = result.rows.find(row => row.observed?.outcomeReceipts === 1).observed;
  assert.equal(observed.metrics.success, null);
  assert.equal(observed.metrics.inputTokens, 0);
  assert.equal(observed.metrics.totalTokens, null);
  assert.equal(observed.adoptionAcknowledged, null);
  assert.equal(result.known.totalCostUSD, 1);
  const pair = result.pairs.find(pair => pair.gain.steps !== null);
  assert.deepEqual([pair.repeat, pair.baseline, pair.candidate], [1, 'none', 'new']);
  assert.deepEqual(pair.gain, { success: null, recurrence: -1, steps: -2, humanCorrections: null, durationMs: -15,
    inputTokens: null, outputTokens: null, totalTokens: null, totalCostUSD: null });
  const terminal = { ...receipt, recurrence: false, event: { ...receipt.event, type: 'run.finished', sequence: 9, outcome: 'cancelled' } };
  current.outcomes = [terminal, receipt];
  assert.equal(report(plan, [baseline, current]).pairs.find(pair => pair.gain.steps !== null).gain.success, null);
  current.outcomes = [terminal];
  assert.equal(report(plan, [current]).known.recurrence, 0);
  current.outcomes = [{ ...terminal, event: { ...terminal.event, type: 'human_gate.opened', outcome: 'awaiting_merge' } }];
  const pending = report(plan, [current]).rows.find(row => row.observed).observed;
  assert.equal(pending.outcome, null);
  assert.equal(pending.metrics.success, null);
  current.controls = 'different-model';
  const mismatch = report(plan, [baseline, current]);
  assert.ok(mismatch.rows.some(row => row.observed?.matchedControls === false));
  assert.ok(mismatch.pairs.every(pair => pair.gain.steps === null));
});

test('rejects wrong identities, reused tasks/runs, changed parameters and conflicting evidence', () => {
  for (const [mutate, message] of [
    [data => { data.current.source = data.baseline.source; }, /receipt task/],
    [data => { data.receipt.event.runId = 'wrong'; }, /event run/],
    [data => { data.receipt.selected.verificationDigest = 'a'.repeat(64); }, /receipt asset/],
    [data => { data.current.asset = data.plan.scenarios.repair.old; }, /assigned asset/],
    [data => { data.current.parameter = 'other'; }, /task parameter/],
    [data => { data.current.recurrence = false; }, /conflicting recurrence/],
    [data => { data.current.outcome = 'succeeded'; data.receipt.event.type = 'run.finished'; }, /conflicting terminal/],
    [data => { data.baseline.outcomes = [data.receipt]; }, /no-asset/],
    [data => { data.baseline.source.runId = data.current.source.runId; }, /reused run/],
    [data => { data.baseline.source.workItemId = data.current.source.workItemId; }, /reused run or work item/],
    [data => { data.baseline.arm = 'new'; }, /duplicate slot/],
    [data => { data.current.repeat = 3; }, /unknown scenario/],
    [data => { data.current.usage.inputTokens = -1; }, /invalid inputTokens/],
  ]) {
    const data = fixture();
    mutate(data);
    assert.throws(() => report(data.plan, [data.baseline, data.current]), message);
  }
});

test('checks candidate publication version in both selected and adoption receipts', () => {
  const { plan, current, receipt } = fixture();
  const candidateId = '1'.repeat(64);
  const setup = plan.scenarios.repair;
  setup.old = { candidateId, validatedVersion: 1 };
  setup.new = { candidateId, validatedVersion: 2 };
  current.asset = setup.new;
  receipt.selected.publication = { ...setup.new, key: '2'.repeat(64), candidateDigest: '3'.repeat(64), evidenceDigest: '4'.repeat(64),
    validatorVersion: 'fixture', targetRef: 'fixture-label' };
  const { source, scope, experienceId, verificationDigest, contextDigest, publication } = receipt.selected;
  current.adoption = { retrievals: 1, adoptions: 1, recurrences: 1, receipt: { version: 2, binding: 'verified-version',
    contextStatus: 'recorded', source, scope, experienceId, verificationDigest, contextDigest, publication, acknowledgedAt: receipt.recordedAt } };
  assert.ok(report(plan, [current]).rows.some(row => row.observed?.adoptionAcknowledged));
  current.adoption.receipt.publication = { ...publication, validatedVersion: 1 };
  assert.throws(() => report(plan, [current]), /receipt asset/);
});

test('keeps a measured baseline while asset bindings are pending in the real project', () => {
  const { plan, baseline } = fixture();
  plan.scope = 'gitlab:parcel/staging';
  plan.scenarios.repair.old = plan.scenarios.repair.new = null;
  assert.throws(() => report(plan, [baseline]), /workItemId/);
  baseline.source.workItemId = `${plan.scope}#218`;
  const result = report(plan, [baseline]);
  assert.deepEqual([result.recorded, result.missing, result.known.success], [1, 17, 1]);
});

test('scores the task check independently of terminal status and preserves its evidence', () => {
  const { plan, baseline } = fixture();
  const observed = () => report(plan, [baseline]).rows.find(row => row.observed).observed;
  delete baseline.taskCheck;
  assert.equal(observed().metrics.success, null);
  baseline.taskCheck = { passed: false, evidence: 'fixture/check-failed' };
  assert.equal(observed().metrics.success, false);
  assert.deepEqual(observed().taskCheck, baseline.taskCheck);
  baseline.taskCheck.evidence = '';
  assert.throws(observed, /task check/);
});

test('requires distinct observed native sessions for paired gains while retaining incomplete runs', () => {
  const { plan, baseline, current } = fixture();
  current.nativeSessionId = baseline.nativeSessionId;
  assert.throws(() => report(plan, [baseline, current]), /reused native session/);
  delete current.nativeSessionId;
  const result = report(plan, [baseline, current]);
  assert.equal(result.recorded, 2);
  assert.equal(result.known.steps, 2);
  assert.ok(result.pairs.every(pair => pair.gain.steps === null));
  assert.equal(result.rows.find(row => row.arm === 'new' && row.observed).observed.nativeSessionId, null);
});
