// Run as an unprivileged user: node mounted-work-item.mjs /path/to/afk-darwin-arm64.tar.gz [expected-sha256] > receipt.json
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer as createHttpServer, request } from 'node:http';
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { branch, names, prepareRepositoryRun, startRepositoryServer } from '../../e2e/repository-managed-local.fixture.ts';

const execute = promisify(execFile);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = async file => (await readFile(file, 'utf8')).trim();
const json = async file => JSON.parse(await read(file));
const save = (file, value) => writeFile(file, JSON.stringify(value));
const service = new URL('../../../services/mounted-workspace/workspace.py', import.meta.url);

async function sample(root) {
  const rows = [];
  for (const { name, lock, bare, config } of await json(join(root, 'probes.json'))) {
    const db = join(config.path, '.git/afk-mounted.sqlite');
    const { stdout } = await execute('sqlite3', ['-readonly', db, 'SELECT value FROM lease']);
    const { claim, id, runId, branch: leasedBranch } = JSON.parse(stdout);
    const mount = join(root, 'managed', `${name}@${runId}`);
    const git = async (directory, ...args) => (await execute('git', ['-C', directory, ...args])).stdout.trim();
    assert.equal(claim, (await json(join(lock, 'claim.json'))).claimId);
    assert.equal(await git(mount, 'branch', '--show-current'), leasedBranch);
    assert.equal(await git(mount, 'rev-parse', '--show-toplevel'), mount);
    if (name === 'api') assert.equal(await realpath('.'), mount);
    const head = await git(mount, 'rev-parse', 'HEAD');
    if (leasedBranch === `${branch}-qa`) {
      await git(mount, 'merge-base', '--is-ancestor', await git(bare, 'rev-parse', branch), head);
      assert.equal(await git(mount, 'show', 'HEAD:shared.txt'), `applied ${name}`);
    }
    rows.push({ name, claim, session: id, runId, mount: basename(mount), branch: leasedBranch, head });
  }
  await appendFile(join(root, 'samples.jsonl'), JSON.stringify(rows) + '\n');
}

async function withHandoffFault(tracker, root) {
  const faults = [];
  let armed = true;
  const server = createHttpServer((input, output) => {
    const upstream = request(`http://${tracker.host}${input.url}`, { method: input.method, headers: input.headers }, async response => {
      if (armed && input.method === 'GET' && input.url.split('?')[0].endsWith('/issues/1')) {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        const body = Buffer.concat(chunks);
        if (JSON.parse(body).labels?.includes('stage::qa') && !(await readdir(join(root, 'managed'))).length) {
          faults.push('GET issue in verification after implementation cleanup');
          output.writeHead(409, { 'Content-Type': 'application/json' });
          output.end('{"message":"fixture handoff interruption"}');
        } else { output.writeHead(response.statusCode, response.headers); output.end(body); }
      } else { output.writeHead(response.statusCode, response.headers); response.pipe(output); }
    });
    upstream.on('error', () => { output.writeHead(502); output.end(); });
    input.pipe(upstream);
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { host: `127.0.0.1:${server.address().port}`, faults, disarm() { armed = false; },
    close: () => new Promise(resolve => server.close(resolve)) };
}

async function qualify(root, archive, standalone, expectedDigest) {
  const archiveSha256 = digest(await readFile(archive));
  assert.equal(archiveSha256, expectedDigest);
  const env = { HOME: root, USERPROFILE: root, PATH: `${root}/bin:/usr/bin:/bin`, NO_COLOR: '1', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'http', NODE_EXTRA_CA_CERTS: join(root, 'tls.pem') };
  const run = async (command, ...args) => (await execute(command, args, { cwd: root, env, timeout: 90_000 })).stdout.trim();
  await run('tar', '-xzf', archive);
  const entry = join(root, 'afk/dist/index.js');
  const cli = (...args) => run(process.execPath, entry, ...args);
  const version = await cli('--version');
  assert.equal(version, '0.2.168');
  assert.equal((await json(join(root, 'afk/release.json'))).version, version);
  const tracker = await startRepositoryServer(root);
  let apache;
  let fault;
  try {
    if (standalone) fault = await withHandoffFault(tracker, root);
    const host = fault?.host ?? tracker.host;
    const { repositories, git, managed, workItemId, manifest } = await prepareRepositoryRun(root, host, entry);
    await mkdir(managed);
    const secret = randomBytes(32).toString('hex');
    await writeFile(join(root, 'token'), secret, { mode: 0o600 });
    const installedService = join(root, 'cgi/workspace');
    await mkdir(dirname(installedService));
    const bytes = await readFile(service);
    await writeFile(installedService, bytes, { mode: 0o700 });
    const configs = [];
    for (const { name, config } of repositories) {
      await git('-C', config.path, 'remote', 'add', 'origin', config.remoteUrl);
      const managedRepo = { name, leaseKey: config.leaseKey, remoteUrl: config.remoteUrl, gitDirectory: join(config.path, '.git') };
      configs.push(managedRepo);
      await save(join(root, `${name}.json`), { ...managedRepo, baseBranch: 'main', workspaceRoot: managed,
        claimsRoot: join(root, '.afk/state/claims/repositories'), tokenFile: join(root, 'token') });
    }
    await save(join(root, 'probes.json'), repositories);
    const agent = join(root, 'bin/claude');
    await rename(agent, `${agent}-fixture`);
    await writeFile(agent, '#!/bin/sh\nset -eu\n"$PROBE_NODE" "$PROBE_SCRIPT" --sample "$HOME"\nexec "$HOME/bin/claude-fixture" "$@"\n', { mode: 0o700 });
    const listen = createServer().listen(0, '127.0.0.1');
    await once(listen, 'listening');
    const { port } = listen.address();
    await new Promise(resolve => listen.close(resolve));
    const endpoint = `https://127.0.0.1:${port}`;
    const apacheBin = process.env.HTTPD || '/usr/sbin/httpd';
    const modules = process.env.APACHE_MODULES || '/usr/libexec/apache2';
    const builtins = await run(apacheBin, '-l');
    const loads = ['mpm_prefork', 'unixd', 'authz_core', 'alias', 'env', 'cgi', 'ssl', 'log_config']
      .filter(name => !builtins.includes(`mod_${name}.c`) && !(name === 'mpm_prefork' && builtins.includes('prefork.c')))
      .map(name => `LoadModule ${name}_module "${modules}/mod_${name}.so"`);
    await writeFile(join(root, 'cert.conf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=127.0.0.1\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=CA:TRUE\n');
    await run('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'tls.key', '-out', 'tls.pem', '-config', 'cert.conf');
    const conf = join(root, 'apache.conf');
    await writeFile(conf, [`ServerRoot "${root}"`, 'ServerName localhost', ...loads, `Listen 127.0.0.1:${port}`,
      `PidFile "${root}/apache.pid"`, `DefaultRuntimeDir "${root}"`, `Mutex file:${root} default`, `DocumentRoot "${root}/cgi"`,
      `<Directory />\nRequire all denied\n</Directory>`, `ErrorLog "${root}/error.log"`, `CustomLog "${root}/access.log" "%m %U %>s"`,
      'SSLEngine on', `SSLCertificateFile "${root}/tls.pem"`, `SSLCertificateKeyFile "${root}/tls.key"`, 'SSLOptions +StdEnvVars',
      `ScriptAlias /workspaces "${installedService}"`, `<Directory "${root}/cgi">\nCGIPassAuth On\nRequire all granted\n</Directory>`,
      ...names.map(name => `<Location /workspaces/${name}/>\nSetEnv AFK_WORKSPACE_CONFIG "${root}/${name}.json"\n</Location>`), ''].join('\n'));
    await run(apacheBin, '-t', '-f', conf);
    apache = spawn(apacheBin, ['-DFOREGROUND', '-f', conf], { cwd: root, env, stdio: 'ignore', detached: true });
    let authProbe;
    for (let attempt = 0; attempt < 50; attempt++) {
      try {
        authProbe = await run('curl', '--silent', '--show-error', '--max-time', '2', '--cacert', 'tls.pem', '-o', '/dev/null', '-w', '%{http_code}', `${endpoint}/workspaces/api/snapshot`);
        break;
      } catch { await delay(100); }
    }
    assert.equal(authProbe, '401');
    Object.assign(env, { AFK_MOUNT_TOKEN: secret, GITLAB_URL: `http://${host}`, GITLAB_TOKEN: 'loopback-fixture',
      PROBE_NODE: process.execPath, PROBE_SCRIPT: import.meta.filename });
    await save(join(root, '.afk/plugins.yml'), { integrations: { repository: { provider: 'remote-workspace' } } });
    await save(join(root, 'remote.json'), { baseUrl: endpoint, token: { env: 'AFK_MOUNT_TOKEN' },
      managed: { workspaceRoot: managed, repositories: configs }, lifecycle: { repositories: names.map(url => ({ url, ref: 'main' })),
        operations: ['prepare', 'checkout', 'publish', 'cleanup'] } });
    await cli('plugin', 'configure', 'repository.remote-workspace', '--builtin', '--file', 'remote.json');
    tracker.requests.length = 0;
    const item = ['--backlog-id', workItemId, '--execution-manifest', manifest, '--agent', 'claude-code'];
    const implementation = cli('run', '--template', 'issue-implementation', '--execution-mode', 'batch', '--hard-timeout', '40000', ...item);
    let handoffDiagnostic;
    if (standalone) {
      await assert.rejects(implementation, error => {
        handoffDiagnostic = error.stderr.trim();
        return error.code === 1 && fault.faults.length > 0;
      });
      fault.disarm();
      assert.equal(await read(join(root, 'context-readers')), 'implementation\nac');
      assert.deepEqual(await readdir(managed), []);
      for (const { lock } of repositories) await assert.rejects(lstat(lock), { code: 'ENOENT' });
    } else await implementation;
    const [workflow] = JSON.parse(await cli('observe', 'runs', '--json'));
    if (standalone) await cli('qa', '--mode', 'batch', ...item);
    assert.equal(await read(join(root, 'context-readers')), 'implementation\nac\nqa');
    const beforeDenial = await read(join(root, 'access.log'));
    const rejected = await cli('qa', '--mode', 'batch', ...item).then(() => assert.fail('expected QA state guard'), error => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /is in merge_ready; QA requires verification state/);
      return error.stderr.trim();
    });
    assert.equal(await read(join(root, 'access.log')), beforeDenial);
    const runs = JSON.parse(await cli('observe', 'runs', '--json'));
    assert.equal(runs.length, standalone ? 2 : 1);
    const observations = [];
    for (const runId of runs) {
      const { state, events, integrity } = JSON.parse(await cli('observe', runId, '--json'));
      assert.equal(integrity.valid, true);
      assert.ok(events.every(event => event.context.workItemId === workItemId));
      assert.equal(events.some(event => event.data.kind === 'qa.passed'), !standalone || runId !== workflow);
      if (!standalone) assert.equal(state.humanGateId, 'merge:2');
      assert.equal(state.run.status, standalone ? (runId === workflow ? 'failed' : 'succeeded') : 'awaiting_human');
      observations.push({ entry: workflow === runId ? 'run' : 'qa', runId, integrity, status: state.run.status,
        gate: state.humanGateId, events: events.map(event => event.data).filter(data => ['commit.recorded', 'change.published', 'qa.passed'].includes(data.kind)) });
    }
    const samples = (await read(join(root, 'samples.jsonl'))).split('\n').map(line => JSON.parse(line));
    assert.equal(samples.length, 3);
    const access = (await read(join(root, 'access.log'))).split('\n');
    const publications = [];
    const events = observations.flatMap(run => run.events);
    const changeRequests = tracker.requests.filter(line => line.startsWith('POST ') && line.endsWith('/merge_requests'));
    assert.equal(changeRequests.length, 1);
    for (const { name, bare, lock, seed, config } of repositories) {
      const revision = await git('-C', bare, 'rev-parse', branch);
      const qaRevision = await git('-C', bare, 'rev-parse', `${branch}-qa`);
      await git('-C', bare, 'merge-base', '--is-ancestor', revision, qaRevision);
      assert.equal(await git('-C', bare, 'show', `${qaRevision}:shared.txt`), `applied ${name}`);
      assert.equal(await git('-C', bare, 'rev-parse', 'main'), seed);
      assert.equal(await git('-C', bare, 'rev-parse', `${revision}^`), seed);
      assert.equal(await git('-C', bare, 'show', `${revision}:shared.txt`), `applied ${name}`);
      const stages = samples.map(rows => rows.find(row => row.name === name));
      assert.equal(stages[0].runId, workflow);
      assert.notEqual(stages[0].runId, stages[2].runId);
      if (standalone) assert.ok(observations.some(run => run.entry === 'qa' && run.runId === stages[2].runId));
      assert.ok(events.some(event => event.kind === 'commit.recorded' && event.phase === 'implementation' && event.commitSha === revision));
      if (name === 'api') assert.ok(events.some(event => event.kind === 'commit.recorded' && event.phase === 'qa' && event.commitSha === qaRevision));
      assert.deepEqual(stages.slice(0, 2).map(row => row.head), [seed, revision]);
      assert.equal(stages[2].head, qaRevision);
      assert.deepEqual(stages.map(row => row.branch), [branch, branch, `${branch}-qa`]);
      assert.equal(stages[0].claim === stages[2].claim, !standalone);
      const sessions = new Set(stages.map(row => row.session));
      assert.equal(sessions.size, 2);
      for (const id of sessions) {
        const route = `/workspaces/${name}/sessions/${id}/`;
        assert.deepEqual(access.filter(line => line.includes(route)).map(line => line.replace(route, '')),
          ['POST checkout 200', 'GET snapshot 200', 'POST publish 200', 'GET snapshot 200', 'POST cleanup 200']);
      }
      assert.equal(access.filter(line => line === `POST /workspaces/${name}/prepare 200`).length, 2);
      assert.ok(tracker.requests.includes(`POST /acme/${name}.git/git-receive-pack`));
      await assert.rejects(lstat(lock), { code: 'ENOENT' });
      assert.equal(await run('sqlite3', '-readonly', join(config.path, '.git/afk-mounted.sqlite'), 'SELECT count(*) FROM lease'), '0');
      assert.deepEqual((await git('-C', config.path, 'worktree', 'list', '--porcelain')).split('\n').filter(line => line.startsWith('worktree ')), [`worktree ${config.path}`]);
      publications.push({ name, seed, revision, qaRevision, main: seed, file: `applied ${name}`, remainingLeases: 0, remainingManagedWorktrees: 0, claimReleased: true });
    }
    assert.deepEqual(await readdir(managed), []);
    return { version, archiveSha256, apache: (await run(apacheBin, '-v')).split('\n')[0], serviceSha256: digest(bytes), workItemId,
      agent: 'local scripted claude', tracker: 'loopback GitLab fixture with git http-backend', observations,
      handoffReadFaults: fault?.faults ?? [], handoffDiagnostic, changeRequests, rejected,
      samples: Object.fromEntries(['implementation', 'ac', standalone ? 'standaloneQA' : 'workflowQA'].map((stage, index) => [stage, samples[index]])),
      publications, access };
  } finally {
    if (apache && apache.exitCode === null && apache.signalCode === null) {
      const stopped = once(apache, 'exit');
      apache.kill();
      await stopped;
    }
    await fault?.close();
    await tracker.close();
  }
}

if (process.argv[2] === '--sample') await sample(process.argv[3]);
else {
  const archive = await realpath(process.argv[2]);
  const expectedDigest = process.argv[3] ?? '2052628b8c6cc81cce726df6c4a8a7df0bc224c73daa2e5499f61c0f05bdf0bf';
  const results = [];
  for (const standalone of [false, true]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-mounted-item-')));
    try { results.push(await qualify(root, archive, standalone, expectedDigest)); }
    finally {
      if (process.env.AFK_E2E_KEEP_REPOSITORY === '1') console.error(`Fixture: ${root}`);
      else await rm(root, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(results, null, 2));
}
