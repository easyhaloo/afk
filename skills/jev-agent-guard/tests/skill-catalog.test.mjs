import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { extractContract, findSkill, listSkillMetadata, recommendSkill, skillRoots } from '../scripts/skill-catalog.mjs';

test('catalog reads bounded Skill metadata and mandatory step titles', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev skill catalog '));
  try {
    const skill = path.join(directory, 'debug');
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, 'SKILL.md'), [
      '---', 'name: systematic-debugging', 'description: Diagnose failing tests before proposing a fix.', '---',
      '# Debug', '## Steps', '1. Reproduce the failing test', '2. Inspect the first failure',
      '## Caveats', '- MUST NOT print credentials',
    ].join('\n'));
    const catalog = listSkillMetadata([directory]);
    assert.equal(catalog.length, 1);
    assert.equal(catalog[0].name, 'systematic-debugging');
    assert.equal(findSkill(catalog, 'systematic-debugging').name, 'systematic-debugging');
    const contract = extractContract(fs.readFileSync(catalog[0].file, 'utf8'));
    assert.deepEqual(contract.steps, ['Reproduce the failing test', 'Inspect the first failure']);
    assert.equal(contract.constraints.length, 1);
    assert.doesNotMatch(JSON.stringify(catalog), /MUST NOT print credentials/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('single relevant Skill is recommended without a Jev request', async () => {
  const catalog = [{ name: 'systematic-debugging', description: 'Diagnose failing tests before a fix.' }];
  const choice = await recommendSkill('Diagnose this failing test', catalog,
    async () => { throw new Error('Jev should not be called'); });
  assert.equal(choice, 'systematic-debugging');
});

test('ambiguous Skill selection delegates a bounded term set to Jev', async () => {
  const catalog = [
    { name: 'review-code', description: 'Review code changes' },
    { name: 'review-security', description: 'Review security changes' },
  ];
  const result = await recommendSkill('Review changes password=super-secret', catalog, async state => {
    assert.doesNotMatch(JSON.stringify(state), /super-secret|password=/);
    return 'review-security';
  });
  assert.equal(result, 'review-security');
});

test('extracted contract strips obvious credential values before remote evaluation', () => {
  const contract = extractContract('---\nname: debug\ndescription: debug\n---\n## Steps\n1. Check token=super-secret\n- MUST NOT reveal password=hunter2\n');
  assert.doesNotMatch(JSON.stringify(contract), /super-secret|hunter2/);
});

test('Skill roots remain absolute when HOME is unavailable', () => {
  const roots = skillRoots('codex', '/project', { USERPROFILE: '/users/example' });
  assert.ok(roots.every(root => path.isAbsolute(root)));
});
