import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const archive = resolve(process.argv[2]);
const archiveSha = createHash('sha256').update(await readFile(archive)).digest('hex');
const image = 'getmeili/meilisearch@sha256:fe500cf9cca05cb9f027981583f28eccf17d35d94499c1f8b7b844e7418152fc';
assert.deepEqual((await readFile(`${archive}.sha256`, 'utf8')).trim().split(/\s+/), [archiveSha, basename(archive)]);
const root = await mkdtemp(join(tmpdir(), 'w10-kb-'));
const name = `w10-kb-${randomUUID()}`;
const master = randomBytes(32).toString('hex');
const environment = { PATH: process.env.PATH, HOME: root, TMPDIR: root, LC_ALL: 'C', NODE_EXTRA_CA_CERTS: join(root, 'cert.pem') };
const docker = (...args) => execute('docker', ['-H', 'unix:///var/run/docker.sock', ...args], {
  cwd: root, env: { ...environment, MEILI_MASTER_KEY: master }, timeout: 60000,
});
const run = (cmd, args) => execute(cmd, args, { cwd: root, env: environment, timeout: 15000 });
const cli = (...args) => run(process.execPath, [join(root, 'afk/dist/index.js'), ...args]);
let backend, server, containerId, paused = false;
const calls = [];

async function api(method, path, token, data) {
  const response = await fetch(new URL(path, backend), { method, redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function configure(id, config) {
  await writeFile(join(root, 'settings.json'), JSON.stringify(config));
  await cli('plugin', 'configure', id, '--builtin', '--file', 'settings.json');
}

async function gather(prompt, scope, limit = 1) {
  await writeFile(join(root, 'query.json'), JSON.stringify({ prompt, scope, limit }));
  const result = await cli('plugin', 'invoke', 'context.provider', 'context.knowledge-base', 'gather', '--input', 'query.json', '--json');
  return JSON.parse(result.stdout);
}

function bridge(tls) {
  return createServer(tls, async (request, response) => {
    try {
      if (request.method !== 'POST' || request.url !== '/gather') return response.writeHead(404).end();
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const { scope, prompt, limit } = JSON.parse(Buffer.concat(chunks));
      if (!/^[a-z0-9_-]+$/.test(scope)) return response.writeHead(400).end();
      const call = { scope, prompt };
      calls.push(call);
      const result = await api('POST', `/indexes/${scope}/search`, request.headers.authorization.slice(7),
        { q: prompt, limit, attributesToRetrieve: ['origin', 'content'] });
      call.status = result.status;
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(result.status === 200 ? result.json.hits : []));
    } catch {
      response.writeHead(502).end();
    }
  });
}

async function expectFailure(operation, message) {
  await assert.rejects(operation, error => error.code === 1 && error.stderr.includes(message) && !error.stdout.trim());
}

async function qualify() {
  await run('/usr/bin/tar', ['-xzf', archive]);
  const version = (await cli('--version')).stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+].+)?$/);
  await writeFile(join(root, 'cert.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=W10\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=CA:TRUE\n');
  await run('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', 'tls.key', '-out', 'cert.pem', '-config', 'cert.cnf']);
  containerId = (await docker('run', '-d', '--name', name, '--tmpfs', '/meili_data', '-p', '127.0.0.1::7700',
    '-e', 'MEILI_MASTER_KEY', '-e', 'MEILI_NO_ANALYTICS=true', image)).stdout.trim();
  const address = (await docker('port', containerId, '7700/tcp')).stdout.trim();
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  backend = `http://${address}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    if ((await api('GET', '/health', master).catch(() => ({}))).json?.status === 'available') break;
    await delay(150);
  }
  const service = (await api('GET', '/version', master)).json;
  assert.equal(service.pkgVersion, '1.15.2');
  const scope = 'manuals';
  const nonce = randomBytes(8).toString('hex');
  const documents = ['saffron', 'cobalt'].map((term, index) => ({ id: index + 1,
    origin: `kb://manuals/${term}/${nonce}`, content: `The ${term} calibration reading is ${randomBytes(6).toString('hex')}.` }));
  const submitted = await api('POST', `/indexes/${scope}/documents?primaryKey=id`, master, documents);
  assert.equal(submitted.status, 202);
  const taskUid = submitted.json.taskUid;
  let task;
  for (let attempt = 0; attempt < 80; attempt++) {
    task = (await api('GET', `/tasks/${taskUid}`, master)).json;
    if (['succeeded', 'failed', 'canceled'].includes(task.status)) break;
    await delay(100);
  }
  assert.equal(task.status, 'succeeded');
  assert.equal(task.details.indexedDocuments, 2);
  const key = await api('POST', '/keys', master, { name: 'W10 reader', actions: ['search'], indexes: [scope], expiresAt: null });
  assert.equal(key.status, 201);
  const reader = key.json.key;
  environment.W10_KB_READER = reader;
  const denied = await api('POST', `/indexes/${scope}/documents`, reader, [{ id: 3, content: 'write probe' }]);
  assert.equal(denied.status, 403);
  server = bridge({ key: await readFile(join(root, 'tls.key')), cert: await readFile(join(root, 'cert.pem')) });
  await new Promise((ready, reject) => server.once('error', reject).listen(0, '127.0.0.1', ready));
  const endpoint = `https://127.0.0.1:${server.address().port}/gather`;
  await configure('credential.enterprise', { values: { reader: { env: 'W10_KB_READER' } } });
  const consumer = { endpoint, timeoutMs: 750, token: { provider: 'credential.enterprise', name: 'reader' } };
  await configure('context.knowledge-base', consumer);
  const results = [];
  for (const [index, term] of ['saffron', 'cobalt'].entries()) {
    const actual = await gather(term, scope);
    const { content, origin } = documents[index];
    assert.deepEqual(actual, [{ content, origin }]);
    results.push({ query: term, ...actual[0] });
  }
  assert.deepEqual(await gather(`absent${nonce}`, scope), []);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.status === 200));
  await docker('pause', containerId);
  paused = true;
  const start = performance.now();
  await expectFailure(gather('saffron', scope), 'Provider HTTP request timed out');
  const timeoutElapsed = Math.round(performance.now() - start);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].status, undefined);
  await docker('unpause', containerId);
  paused = false;
  assert.deepEqual(await gather('saffron', scope), [{ content: documents[0].content, origin: documents[0].origin }]);
  const settings = join(root, '.afk/plugins.yml');
  const before = await readFile(settings);
  assert.ok(!before.includes(reader) && !before.includes(master));
  const removal = await api('DELETE', `/keys/${key.json.uid}`, master);
  assert.equal(removal.status, 204);
  await expectFailure(gather('saffron', scope), 'Provider HTTP request failed (403)');
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.at(-1), { scope, prompt: 'saffron', status: 403 });
  assert.deepEqual(await readFile(settings), before);
  const control = await api('POST', `/indexes/${scope}/search`, master, { q: 'saffron', limit: 1 });
  assert.equal(control.status, 200);
  assert.deepEqual(control.json.hits, [documents[0]]);
  return { timestamp: new Date().toISOString(), version, archiveSha, image, service, scope,
    indexing: { taskUid, status: task.status, indexedDocuments: task.details.indexedDocuments }, results,
    unmatched: [], readerWriteStatus: denied.status, timeoutMs: consumer.timeoutMs, timeoutCliWallMs: timeoutElapsed,
    recovery: true, revokeStatus: removal.status, postRevocation: calls.at(-1), postRevocationCliExit: 1,
    unchangedSettings: true, privilegedControlStillFindsDocument: true };
}

let receipt;
try {
  receipt = await qualify();
} finally {
  try {
    if (paused) await docker('unpause', containerId);
    if (server?.listening) await new Promise(done => { server.close(done); server.closeAllConnections(); });
  } finally {
    if (containerId) await docker('rm', '-fv', containerId);
    await rm(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ ...receipt, cleanup: 'container and temporary AFK profile removed' }, null, 2));
