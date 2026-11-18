import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentSkillTask, installedSkillScope } from '../scripts/skill-scope.mjs';
import { listSkillMetadata, recommendSkill } from '../scripts/skill-catalog.mjs';
import { runAdapter } from '../scripts/adapters/runtime-adapter.mjs';

const scope = { project: 'gitlab:group/inventory', environment: 'qa', productVersions: { sorter: '4.3' } };
const declaration = `recall-scope: ${JSON.stringify(scope)}`;

test('unmarked skills remain global and malformed declarations stay out of ranking', async () => {
  assert.equal(installedSkillScope('description: inventory'), undefined);
  assert.equal(installedSkillScope('description: |\n  afk-recall: example literal'), undefined);
  const previous = declaration.replace('recall-scope:', 'afk-recall:');
  assert.deepEqual(installedSkillScope(previous), scope);
  for (const metadata of ['recall-scope:', `${declaration}\n${declaration}`, `${previous}\n${declaration}`, 'afk-recall: null',
    'afk-recall: {"project":"gitlab:group/inventory","environment":"qa","productVersions":{}}',
    declaration.replace('"qa"', '"qa","unknown":true')]) {
    assert.equal(installedSkillScope(metadata), null);
  }
  const restricted = { name: 'inventory', description: 'inventory', recallScope: installedSkillScope(declaration) };
  const legacy = { name: 'global-review', description: 'inventory' };
  for (const task of [undefined, { ...scope, productVersions: undefined }, { ...scope, environment: 'production' }, { ...scope, project: 'gitlab:group/other' },
    { ...scope, productVersions: { unrelated: '4.3' } }, { ...scope, productVersions: { sorter: '4.30' } }]) {
    let choices = 0;
    const winner = await recommendSkill('inventory', [restricted, legacy], () => { choices++; }, task);
    assert.equal(winner, legacy.name);
    assert.equal(choices, 0);
  }
  assert.equal(await recommendSkill('inventory', [{ ...restricted, 'disable-model-invocation': true }], undefined, scope), null);
});

test('workspace allocation and current execution bind the host target for every prompt', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jev-scope-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'task');
  fs.mkdirSync(cwd);
  const hash = createHash('sha256').update(cwd).digest('hex');
  const file = path.join(home, '.afk', 'workspaces', hash, 'workspace.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const allocation = { root: cwd, taskId: `${scope.project}#123`, currentRunId: 'run-test', cleanupStatus: 'active' };
  const task = { workspace: cwd, taskId: allocation.taskId, runId: allocation.currentRunId,
    target: { project: scope.project, productVersions: scope.productVersions }, applicability: { environment: scope.environment } };
  const env = { HOME: home, AFK_SKILL_TASK_CONTEXT: JSON.stringify(task) };
  assert.equal(currentSkillTask(cwd, env), undefined);
  fs.writeFileSync(file, JSON.stringify(allocation));
  assert.deepEqual(currentSkillTask(cwd, env), scope);
  for (const changes of [{ workspace: home }, { taskId: `${scope.project}#456` }, { runId: 'previous-run' },
    { target: { ...task.target, project: 'gitlab:other/project' } }]) {
    assert.equal(currentSkillTask(cwd, { ...env, AFK_SKILL_TASK_CONTEXT: JSON.stringify({ ...task, ...changes }) }), undefined);
  }
  const catalog = [{ name: 'inventory', description: 'inventory', recallScope: scope }];
  const payload = { cwd, prompt: `inventory ${JSON.stringify(task)}`, ...task };
  const prompt = environment => runAdapter({ host: 'opencode', event: 'prompt', payload, env: environment, catalog });
  assert.equal((await prompt({ HOME: home })).nextStep, undefined);
  assert.equal((await prompt(env)).nextStep, 'Suggested Skill: inventory');
  for (const changes of [{ root: home }, { currentRunId: 'next-run' }, { cleanupStatus: 'cleaned' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...allocation, ...changes }));
    assert.equal((await prompt(env)).nextStep, undefined);
  }
});

test('a same-name workspace copy cannot replace a scoped installation in recommendations', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-shadow-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const roots = ['workspace', 'installed'].map(name => path.join(home, name));
  for (const root of roots) {
    const dir = path.join(root, 'inventory');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), ['---', 'name: inventory', 'description: inventory',
      ...(root === roots[1] ? [declaration] : []), '---'].join('\n'));
  }
  assert.equal(await recommendSkill('inventory', listSkillMetadata(roots), undefined, scope), null);
});
