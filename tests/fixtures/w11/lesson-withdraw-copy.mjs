import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

process.umask(0o077);
const [source, profile, evidence] = process.argv.slice(2, 5).map(path => realpathSync(path));
const image = process.argv[5];
assert.match(image, /^sha256:[a-f0-9]{64}$/);
assert.equal(profile.endsWith('/lesson-05'), true);
assert.notEqual(profile, source);
const read = path => JSON.parse(readFileSync(path));
const install = read(join(source, 'installed.json'));
const cliRoot = dirname(dirname(install.binary));
const script = read(join(source, 'config.json')).knowledge.wikiScript;
const grantPath = join(profile, 'grant.json');
assert.equal(realpathSync(grantPath), grantPath);
assert.equal(lstatSync(grantPath).nlink, 1);
const grant = read(grantPath);
assert.deepEqual(grant, read(join(source, 'grant.json')));
assert.equal(grant.revoked, false);
assert.equal(grant.allowWithdrawal, true);
assert.equal(grant.policy.vault, join(source, 'wiki'));
const snapshot = (file, name) => copyFileSync(file, join(evidence, name), 1);
snapshot(grantPath, 'grant-before.json');
snapshot(join(profile, 'wiki/Label.md'), 'page-before.md');
writeFileSync(grantPath, JSON.stringify({ ...grant, revoked: true }, null, 2));
snapshot(grantPath, 'grant-after.json');
const args = ['run', '--rm', '--pull=never', '--network', 'none',
  '-v', `${profile}:${source}`, '-v', `${cliRoot}:/release:ro`, '-v', `${dirname(script)}:${dirname(script)}:ro`,
  '-e', `HOME=${source}`, '-e', `AFK_EVENT_STORE_DIR=${source}/events`, '-w', source,
  '--entrypoint', 'node', image, '/release/dist/index.js', 'experience', 'knowledge', 'reconcile', '--scope', grant.policy.scope, '--json'];
const started = new Date().toISOString();
const { status, signal, stdout, stderr, pid } = spawnSync('docker', args, { encoding: 'utf8', timeout: 150_000 });
writeFileSync(join(evidence, 'reconcile.receipt.json'), JSON.stringify({ executable: 'docker', argv: args, started,
  finished: new Date().toISOString(), pid, status, signal, stdout, stderr }, null, 2), { flag: 'wx' });
assert.equal(status, 0, stderr);
const result = JSON.parse(stdout);
assert.deepEqual(result.blocked, []);
const { publication, withdrawal } = result.results.find(item => item.publication.targetRef === 'wiki:label-offset');
assert.equal(withdrawal.status, 'withdrawn');
const directory = join(profile, '.afk/learning/publications', publication.key);
for (const name of ['withdrawal.json', 'withdrawal-result.json']) snapshot(join(directory, name), name);
snapshot(join(profile, 'wiki/Label.md'), 'page-after.md');
snapshot(join(source, 'wiki/Label.md'), 'source-page-after.md');
snapshot(join(source, 'grant.json'), 'source-grant-after.json');
