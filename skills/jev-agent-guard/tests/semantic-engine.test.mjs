import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { auditRecord, evaluateSemantic } from '../scripts/semantic-engine.mjs';

test('audit log and directory are owner-only in a real user home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev audit '));
  const moduleUrl = new URL('../scripts/semantic-engine.mjs', import.meta.url).href;
  const code = `import { evaluateSemantic } from ${JSON.stringify(moduleUrl)};
    await evaluateSemantic('action-risk', {}, {}, { ask: async () => ({ answers: {
      dangerous: { type: 'noul', noul: 0 },
      handling: { type: 'choice', choice: 'allow' },
      severity: { type: 'score', score: 0 },
    } }) });`;
  execFileSync(process.execPath, ['--input-type=module', '--eval', code], {
    env: { ...process.env, HOME: home },
  });
  const directory = path.join(home, '.afk', 'jev-agent-guard');
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(directory, 'semantic-engine.jsonl')).mode & 0o777, 0o600);
});

test('audit records contain decisions but not provider state or answers', () => {
  const record = auditRecord('action-risk', { decision: 'deny', reason: 'blocked' }, {
    command: 'password=super-secret', answers: { dangerous: 1 },
  });
  assert.deepEqual(record, { type: 'evaluate', ruleId: 'action-risk', decision: 'deny' });
  assert.doesNotMatch(JSON.stringify(record), /password|super-secret|answers/);
});

test('action-risk denies a high Jev danger probability', async () => {
  const response = await evaluateSemantic('action-risk', { action: { tool: 'Bash' } }, {}, {
    ask: async () => ({ answers: {
      dangerous: { type: 'noul', noul: 0.95 },
      handling: { type: 'choice', choice: 'allow' },
      severity: { type: 'score', score: 0 },
    } }), log: () => {},
  });
  assert.equal(response.decision, 'deny');
});

test('moderate action risk defers to native permissions without requesting approval', async () => {
  const response = await evaluateSemantic('action-risk', { action: { tool: 'Bash', risk: 'network' } }, {}, {
    ask: async () => ({ answers: {
      dangerous: { type: 'noul', noul: 0.6 },
      handling: { type: 'choice', choice: 'confirm' },
      severity: { type: 'score', score: 1 },
    } }), log: () => {},
  });
  assert.equal(response.decision, 'warn');
  assert.equal(response.action, 'defer_to_host');
  assert.doesNotMatch(response.reason, /human review|approval/i);
});

test('malformed provider answers cannot silently become an allow decision', async () => {
  await assert.rejects(() => evaluateSemantic('action-risk', {}, {}, {
    ask: async () => ({ answers: {} }), log: () => {},
  }), /Malformed Jev answer/);
});

test('Skill compliance names a specific unfinished Playbook step before redirecting', async () => {
  const result = await evaluateSemantic('skill-compliance', {
    skill: { name: 'build', steps: ['Check git status', 'Run the build'] },
    evidence: [{ tool: 'Bash', success: false }],
  }, {}, { ask: async ({ questions }) => {
    assert.match(JSON.stringify(questions.missing_step), /Run the build/);
    return { answers: {
      compliant: { type: 'noul', noul: 0.4 },
      next_step: { type: 'choice', choice: 'return_to_missing_step' },
      missing_step: { type: 'choice', choice: 'step_2' },
    } };
  }, log: () => {} });
  assert.equal(result.decision, 'redirect');
  assert.match(result.nextStep, /Run the build/);
});

test('uncertain Skill compliance does not assert that work is missing', async () => {
  const result = await evaluateSemantic('skill-compliance', {
    skill: { name: 'build', steps: ['Run the build'] }, evidence: [],
  }, {}, { ask: async () => ({ answers: {
    compliant: { type: 'noul', noul: 0.3 },
    next_step: { type: 'choice', choice: 'return_to_missing_step' },
    missing_step: { type: 'choice', choice: 'unknown' },
  } }), log: () => {} });
  assert.equal(result.decision, 'warn');
  assert.doesNotMatch(result.reason, /still needs work/);
});

test('uncertain validation gives a safe next action without claiming a missing step', async () => {
  const result = await evaluateSemantic('skill-compliance', {
    skill: { name: 'build', steps: ['Run the build'] }, evidence: [],
  }, {}, { ask: async () => ({ answers: {
    compliant: { type: 'noul', noul: 0.5 },
    next_step: { type: 'choice', choice: 'validate' },
    missing_step: { type: 'choice', choice: 'unknown' },
  } }), log: () => {} });
  assert.equal(result.decision, 'warn');
  assert.match(result.nextStep, /Run the required validation/);
});
