import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [phase, id, sourceArg, workArg, evidenceArg] = process.argv.slice(2);
assert.match(id, /^lesson-0[3-6]$/);
assert.ok(phase === 'fresh' || (phase === 'after-withdrawal' && id === 'lesson-05'));
process.umask(0o077);
const source = realpathSync(sourceArg);
const profile = resolve(workArg, id);
const output = resolve(evidenceArg, id);
const { recallCases } = await import(join(realpathSync(evidenceArg), 'recall-v1.ts'));
const query = caseId => recallCases.find(row => row.id === caseId).query;
const { binary } = JSON.parse(readFileSync(join(source, 'installed.json')));
const save = (name, data) => writeFileSync(join(output, name), JSON.stringify(data, null, 2), { flag: 'wx' });
function invoke(name, args, guardSource = false) {
  const argv = [binary, ...args, '--json'];
  const env = { HOME: profile, PATH: process.env.PATH, AFK_EVENT_STORE_DIR: join(profile, 'events') };
  const started = new Date().toISOString();
  const policy = `(version 1)(allow default)(deny file-write* (subpath ${JSON.stringify(source)}))(allow file-write-data (literal ${JSON.stringify(join(source, 'wiki/.learning-publication.lock'))}))`;
  const executable = guardSource ? '/usr/bin/sandbox-exec' : process.execPath;
  const command = guardSource ? ['-p', policy, process.execPath, ...argv] : argv;
  const { pid, status, signal, stdout, stderr, error } = spawnSync(executable, command, {
    cwd: profile, encoding: 'utf8', env, timeout: 120_000,
  });
  save(`${name}.receipt.json`, { executable, argv: command, cwd: profile, env, started,
    finished: new Date().toISOString(), pid, status, signal, stdout, stderr, error: error?.message });
  assert.equal(status, 0, stderr || error?.message);
  return JSON.parse(stdout);
}
function gather(name, caseId) {
  const filename = `${name}.input.json`;
  save(filename, query(caseId));
  return invoke(name, ['plugin', 'invoke', 'context.provider', 'context.experience', 'gather', '--input', join(output, filename)]);
}
const list = name => invoke(name, ['experience', 'list', '--scope', query(id).scope]);
if (phase === 'fresh') {
  mkdirSync(profile);
  mkdirSync(output);
  if (id === 'lesson-06') {
    const entries = readdirSync(profile);
    const missing = ['candidates.sqlite', 'experience.sqlite'].map(file => {
      try { lstatSync(join(profile, '.afk/learning', file)); } catch (error) { return [file, error.code]; }
      throw new Error(`Ledger already exists: ${file}`);
    });
    save('initial.json', { profile, entries, missing });
  } else {
    const files = ['.afk/learning/candidates.sqlite', '.afk/learning/publications', '.afk/plugins', '.afk/plugins.yml', 'events', 'wiki', 'grant.json', 'checkers.json', 'oracle.json'];
    for (const file of files) cpSync(join(source, file), join(profile, file), { recursive: true, verbatimSymlinks: true });
    const authorized = JSON.parse(readFileSync(join(source, 'verified.json')));
    const binding = authorized.find(item => item.publication?.targetRef === 'wiki:label-offset').publication;
    const projected = invoke('project', ['experience', 'knowledge', 'publish', binding.key, '--scope', query(id).scope], true);
    assert.deepEqual(projected.experienceProjection.blocked, []);
    const records = list('list-before');
    assert.equal(records.length, 1);
    const [record] = records;
    assert.deepEqual(record.publication, binding);
    const positive = gather('positive', 'lesson-01');
    assert.equal(record.status, 'verified');
    assert.equal(positive.length, 1);
    assert.equal(positive[0].origin, `experience:${record.id}; verification:run:${record.verifiedEvidence.runId}; expires:${record.expiresAt}`);
  }
}
if (id !== 'lesson-05' || phase === 'after-withdrawal') {
  if (id === 'lesson-05') assert.deepEqual(gather('alias-after', 'lesson-02'), []);
  assert.deepEqual(gather('observed', id), []);
  list('list-after');
  if (['lesson-03', 'lesson-04'].includes(id)) assert.equal(gather('positive-after', 'lesson-01').length, 1);
}
