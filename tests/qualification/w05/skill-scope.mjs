import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const source = join(root, 'skills/jev-agent-guard');
const install = join(source, 'scripts/install.mjs');
const sdk = process.argv[2] ?? join(homedir(), '.local/share/jev-agent-guard/current/node_modules/@typesafe-ai/sdk');
const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'skill-scope-')));
const workspace = join(home, 'workspace');
const env = { HOME: home, PATH: dirname(process.execPath), TMPDIR: home };
const run = (bin, args, options) => execFileSync(bin, args, { cwd: workspace, env, timeout: 10000, encoding: 'utf8', ...options });
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const write = (file, bytes) => {
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
};
const scope = { project: 'github:fixture/inventory', environment: 'qa', productVersions: { sorter: '4.3', scanner: '2' } };
const taskId = `${scope.project}#42`;
const task = { workspace, taskId, runId: 'fixture-run', target: { project: scope.project, productVersions: scope.productVersions }, applicability: { environment: scope.environment } };
const skill = join(home, '.agents/skills/inventory/SKILL.md');
const content = fields => ['---', 'name: inventory', 'description: inventory', ...fields, '---', 'List the synthetic inventory.', ''].join('\n');
const receipt = { cases: [] };
try {
  fs.mkdirSync(workspace);
  run(process.execPath, [install, 'install', '--host=codex', '--skip-sdk']);
  const doctor = () => JSON.parse(run(process.execPath, [install, 'doctor', '--host=codex']));
  const runtime = doctor().runtime.path;
  assert.equal(runtime, join(home, '.local/share/jev-agent-guard/current'));
  const lock = json(join(runtime, 'npm-shrinkwrap.json'));
  const sdkKey = 'node_modules/@typesafe-ai/sdk';
  assert.equal(json(join(sdk, 'package.json')).version, lock.packages[sdkKey].version);
  fs.cpSync(sdk, join(runtime, sdkKey), { recursive: true, dereference: true });
  const installed = doctor();
  assert.ok(installed.runtime.sdk && installed.hosts.codex.configured);
  const [hook] = json(installed.hosts.codex.path).hooks.UserPromptSubmit.flatMap(group => group.hooks);
  const adapter = 'scripts/adapters/codex.mjs';
  assert.ok(hook.command.includes(join(runtime, adapter)));
  receipt.plugin = json(join(root, '.claude-plugin/plugin.json')).version;
  receipt.node = process.version;
  receipt.sdk = lock.packages[sdkKey].version;
  receipt.installedDigests = {};
  for (const file of [adapter, 'scripts/adapters/runtime-adapter.mjs', 'scripts/skill-catalog.mjs', 'scripts/skill-scope.mjs']) {
    const actual = digest(fs.readFileSync(join(runtime, file)));
    assert.equal(actual, digest(fs.readFileSync(join(source, file))));
    receipt.installedDigests[file] = actual;
  }
  write(join(home, '.afk/workspaces', digest(workspace), 'workspace.json'), JSON.stringify({ root: workspace, taskId, currentRunId: task.runId, cleanupStatus: 'active' }));
  function check(name, fields, context, recommended) {
    write(skill, content(fields));
    const output = JSON.parse(run('/bin/sh', ['-c', hook.command], {
      env: context ? { ...env, AFK_SKILL_TASK_CONTEXT: JSON.stringify(context) } : env,
      input: JSON.stringify({ cwd: workspace, session_id: name, prompt: 'inventory' }),
    }));
    const expected = recommended ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'Suggested Skill: inventory' } } : { continue: true };
    assert.deepEqual(output, expected, name);
    receipt.cases.push({ name, skillSha256: digest(content(fields)), output });
  }
  const declaration = key => `${key}: ${JSON.stringify(scope)}`;
  for (const key of ['afk-recall', 'recall-scope']) {
    const fields = [declaration(key)];
    const checkKey = (name, context, recommended = false) => check(`${key}/${name}`, fields, context, recommended);
    checkKey('match', task, true);
    checkKey('missing-context', null);
    checkKey('previous-run', { ...task, runId: 'previous-run' });
    checkKey('environment', { ...task, applicability: { environment: 'prod' } });
    checkKey('project', { ...task, target: { ...task.target, project: 'github:fixture/unrelated' } });
    checkKey('version', { ...task, target: { ...task.target, productVersions: { sorter: '4.30', scanner: '2' } } });
    checkKey('missing-product', { ...task, target: { ...task.target, productVersions: { sorter: '4.3' } } });
    check(`${key}/manual`, [...fields, 'disable-model-invocation: true'], task, false);
    checkKey('restored', task, true);
  }
  check('both-keys', ['afk-recall', 'recall-scope'].map(declaration), task, false);
  check('malformed', ['recall-scope: null'], task, false);
  check('unmarked', [], null, true);
  write(join(workspace, '.agents/skills/inventory/SKILL.md'), content([]));
  check('workspace-shadow', [declaration('afk-recall')], task, false);
  console.log(JSON.stringify(receipt, null, 2));
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
