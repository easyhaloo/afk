import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(import.meta.url);
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const load = path => JSON.parse(readFileSync(path, 'utf8'));
const mainRef = 'refs/heads/main';

async function receive() {
  const url = new URL('/triggers/trigger.git-push', process.env.PARCEL_LISTENER);
  assert.equal(url.origin, `http://127.0.0.1:${url.port}`);
  for (const line of readFileSync(0, 'utf8').trim().split('\n')) {
    const [before, after, ref] = line.split(' ');
    const body = JSON.stringify({ before, after, ref, deleted: /^0+$/.test(after) });
    const sourceId = randomUUID();
    const send = async key => {
      const signature = createHmac('sha256', key).update(body).digest('hex');
      const response = await fetch(url, { method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json', 'idempotency-key': sourceId, 'x-hub-signature-256': `sha256=${signature}` } });
      return { status: response.status, receipt: await response.json() };
    };
    const invalid = await send(randomBytes(32));
    const accepted = await send(process.env.PARCEL_AUTH);
    const retry = await send(process.env.PARCEL_AUTH);
    appendFileSync(process.env.PARCEL_HOOK_LOG, JSON.stringify({ line, sourceId, invalid, accepted, retry }) + '\n');
  }
}

async function qualify(launcher, receiptDir) {
  const product = realpathSync(launcher);
  const root = mkdtempSync(join(realpathSync(receiptDir), 'git-push.'));
  console.log(root);
  const project = join(root, 'project');
  const bare = join(root, 'parcel.git');
  const effects = join(root, 'actions.txt');
  const hookLog = join(root, 'post-receive.ndjson');
  const env = { HOME: join(root, 'profile'), TMPDIR: join(root, 'tmp'), XDG_CONFIG_HOME: join(root, 'profile/config'),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_ALLOW_PROTOCOL: 'file', GIT_TERMINAL_PROMPT: '0', PARCEL_AUTH: randomBytes(32).toString('hex'), PARCEL_HOOK_LOG: hookLog };
  for (const directory of [env.HOME, env.TMPDIR, project]) mkdirSync(directory);
  const run = (cmd, ...args) => execFileSync(cmd, args, { cwd: root, env, encoding: 'utf8', timeout: 15000 }).trim();
  const cli = (...args) => run(product, 'plugin', ...args);
  const git = (...args) => run('git', '-C', project, ...args);
  const tip = (dir, ref) => run('git', '-C', dir, 'rev-parse', '--verify', ref);
  for (const operation of ['configure', 'listen', 'deliveries']) writeFileSync(join(root, `${operation}-help.txt`), cli(operation, '--help'));
  save(join(root, 'tools.json'), { product, version: run(product, '--version'), git: run('git', '--version'), node: process.version });
  git('init', '-b', 'main');
  run('git', 'init', '--bare', '-b', 'main', bare);
  const commit = value => {
    writeFileSync(join(project, 'parcel.txt'), value + '\n');
    git('add', 'parcel.txt');
    git('-c', 'user.name=Parcel', '-c', 'user.email=parcel@example.invalid', 'commit', '-m', value);
    return tip(project, 'HEAD');
  };
  const before = commit('prepared');
  git('push', bare, `HEAD:${mainRef}`);
  const after = commit('checked');
  const configure = (id, config, ...options) => {
    const path = join(root, `${id}.json`);
    save(path, config);
    cli('configure', id, '--builtin', '--file', path, ...options);
  };
  configure('verification.test-runner', { command: [process.execPath, script, 'record-tip', effects] });
  configure('trigger.git-push', { triggers: [{ id: 'parcel-main', kind: 'webhook', payload: { branch: 'main' },
    input: { capability: 'verification.provider', provider: 'test-runner', operation: 'verify', input: { target: bare } } }] }, '--action', 'capability.invoke');

  const listener = spawn(product, ['plugin', 'listen', '--host', '127.0.0.1', '--port', '0', '--queue', join(root, 'queue.sqlite'), '--token-env', 'PARCEL_AUTH'],
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(listener, 'close');
  listener.stderr.on('data', chunk => appendFileSync(join(root, 'listener.stderr'), chunk));
  try {
    const ready = await once(listener.stdout, 'data', { signal: AbortSignal.timeout(15000) });
    const match = /Plugin listener ready at (127\.0\.0\.1:\d+)/.exec(ready[0].toString());
    assert.ok(match, 'installed listener readiness');
    env.PARCEL_LISTENER = `http://${match[1]}`;
    const hook = join(bare, 'hooks/post-receive');
    writeFileSync(hook, '#!/bin/sh\nexec "$PARCEL_NODE" "$PARCEL_HARNESS" receive\n', { mode: 0o700 });
    env.PARCEL_NODE = process.execPath;
    env.PARCEL_HARNESS = script;
    for (const branch of ['preview', 'main']) {
      const ref = `refs/heads/${branch}`;
      git('push', bare, `HEAD:${ref}`);
      assert.equal(tip(bare, ref), after);
      const events = readFileSync(hookLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      const matching = branch === 'main';
      assert.equal(events.length, matching ? 2 : 1);
      const { line, invalid, accepted, retry } = events.at(-1);
      assert.equal(line, `${matching ? before : '0'.repeat(after.length)} ${after} ${ref}`);
      assert.equal(invalid.status, 401);
      assert.equal(accepted.status, 202);
      assert.equal(accepted.receipt.duplicate, false);
      assert.equal(retry.status, 202);
      assert.equal(retry.receipt.duplicate, true);
      assert.equal(accepted.receipt.deliveryId, retry.receipt.deliveryId);
      const deadline = Date.now() + 10000;
      let deliveries;
      do {
        deliveries = JSON.parse(cli('deliveries', '--url', env.PARCEL_LISTENER, '--token-env', 'PARCEL_AUTH')).deliveries;
        if (deliveries.every(record => record.status === 'delivered')) break;
        await delay(100);
      } while (Date.now() < deadline);
      assert.deepEqual(new Set(deliveries.map(record => record.deliveryId)), new Set(events.map(event => event.accepted.receipt.deliveryId)));
      assert.ok(deliveries.every(record => record.providerId === 'trigger.git-push' && record.status === 'delivered' && record.attempts === 1));
      save(join(root, `${branch}-deliveries.json`), deliveries);
      const observed = existsSync(effects) ? readFileSync(effects, 'utf8').trim().split('\n') : [];
      assert.deepEqual(observed, matching ? [after] : []);
    }
    save(join(root, 'verified.json'), { before, after, source: 'local bare Git post-receive', actionTips: [after], provider: 'trigger.git-push' });
  } finally {
    listener.kill('SIGTERM');
    assert.deepEqual(await closed, [0, null]);
  }
}

process.umask(0o077);
const [mode, argument] = process.argv.slice(2);
if (mode === 'receive') await receive();
else if (mode === 'record-tip') appendFileSync(argument, execFileSync('git', ['rev-parse', '--verify', mainRef], { encoding: 'utf8' }));
else await qualify(resolve(mode), resolve(argument));
