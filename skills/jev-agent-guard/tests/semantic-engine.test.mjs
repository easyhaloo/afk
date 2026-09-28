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

test('malformed provider answers cannot silently become an allow decision', async () => {
  await assert.rejects(() => evaluateSemantic('action-risk', {}, {}, {
    ask: async () => ({ answers: {} }), log: () => {},
  }), /Malformed Jev answer/);
});
