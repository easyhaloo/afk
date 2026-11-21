import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import Provider from 'oidc-provider';

const execute = promisify(execFile);
const scope = 'report.write';
const ttl = 8;
const servers = [];
const nonce = () => randomBytes(32).toString('hex');
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));
const tls = { key: await readFile('tls.key'), cert: await readFile('tls.crt') };
async function listen() {
  const server = createServer(tls);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return [server, `https://127.0.0.1:${server.address().port}`];
}

async function qualify() {
  const release = await readJson('afk/release.json');
  assert.equal(release.platform, process.platform);
  assert.equal(release.arch, process.arch);
  const cliEnv = { ...process.env, AFK_EVENT_STORE_DIR: resolve('events') };
  const cli = (...args) => execute(process.execPath, [resolve('afk/dist/index.js'), ...args], {
    cwd: resolve('workspace'), env: cliEnv, timeout: 12000,
  });
  assert.equal((await cli('--version')).stdout.trim(), release.version);
  const [authority, issuer] = await listen();
  const [resource, origin] = await listen();
  const inspector = { client_id: 'w10-resource', client_secret: nonce(), grant_types: ['client_credentials'],
    response_types: [], redirect_uris: [], token_endpoint_auth_method: 'client_secret_basic' };
  const enrollment = nonce();
  const signingKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'jwk' });
  const provider = new Provider(issuer, {
    clients: [inspector], scopes: [scope], ttl: { ClientCredentials: ttl }, clockTolerance: 0,
    jwks: { keys: [{ ...signingKey, alg: 'RS256', use: 'sig' }] }, cookies: { keys: [nonce()] },
    features: {
      devInteractions: { enabled: false }, clientCredentials: { enabled: true },
      introspection: { enabled: true, allowedPolicy: (_ctx, client) => client.clientId === inspector.client_id },
      revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => client.clientId === token.clientId },
      registration: { enabled: true, initialAccessToken: enrollment }, registrationManagement: { enabled: true },
    },
  });
  authority.on('request', provider.callback());
  const metadata = await (await fetch(`${issuer}/.well-known/openid-configuration`)).json();
  assert.equal(metadata.issuer, issuer);
  for (const field of ['registration_endpoint', 'token_endpoint', 'revocation_endpoint', 'introspection_endpoint']) {
    assert.equal(new URL(metadata[field]).origin, issuer);
  }
  const registration = await fetch(metadata.registration_endpoint, { method: 'POST',
    headers: { authorization: `Bearer ${enrollment}`, 'content-type': 'application/json' },
    body: JSON.stringify({ grant_types: ['client_credentials'], response_types: [], redirect_uris: [],
      scope, token_endpoint_auth_method: 'client_secret_basic' }),
  });
  assert.equal(registration.status, 201);
  const client = await registration.json();
  assert.equal(new URL(client.registration_client_uri).origin, issuer);
  cliEnv.W10_CLIENT_SECRET = client.client_secret;
  const grants = [];
  provider.on('grant.success', ctx => grants.push({ grant: ctx.oidc.params.grant_type, scope: ctx.oidc.params.scope,
    method: ctx.headers.authorization?.split(' ')[0], clientMatches: ctx.oidc.client.clientId === client.client_id }));
  const refusals = [];
  provider.on('grant.error', (_ctx, err) => refusals.push({ error: err.error ?? err.message, status: err.statusCode }));
  function tokenAction(endpoint, caller, token) {
    const basic = Buffer.from(`${caller.client_id}:${caller.client_secret}`).toString('base64');
    return fetch(endpoint, { method: 'POST', headers: { authorization: `Basic ${basic}` },
      body: new URLSearchParams({ token, token_type_hint: 'access_token' }) });
  }
  const inspect = async token => {
    const response = await tokenAction(metadata.introspection_endpoint, inspector, token);
    assert.equal(response.status, 200);
    return response.json();
  };
  const body = Buffer.from(`w10-${nonce()}`);
  const reports = [];
  let reportRequests = 0;
  resource.on('request', async (req, res) => {
    reportRequests++;
    try {
      assert.equal(req.url, '/reports');
      assert.equal(req.method, 'POST');
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      assert.ok(Buffer.concat(chunks).equals(body));
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization)?.[1];
      assert.ok(token);
      const status = await inspect(token);
      const accepted = status.active && status.client_id === client.client_id && status.scope === scope;
      reports.push({ token, status });
      res.writeHead(accepted ? 200 : 401, { 'content-type': 'application/json' });
      res.end(JSON.stringify(accepted ? { uri: `${origin}/saved` } : {}));
    } catch { res.writeHead(500).end(); }
  });
  const configure = async (id, config) => {
    const file = resolve(`${id}.json`);
    await writeFile(file, JSON.stringify(config));
    await cli('plugin', 'configure', id, '--builtin', '--file', file);
  };
  await configure('credential.oauth', { tokenEndpoint: metadata.token_endpoint, clientId: client.client_id,
    clientSecret: { env: 'W10_CLIENT_SECRET' } });
  await configure('artifact.report-platform', { endpoint: `${origin}/reports`,
    token: { provider: 'credential.oauth', name: 'report', scope } });
  const input = resolve('artifact.json');
  await writeFile(input, JSON.stringify({ name: 'report.txt', mediaType: 'text/plain', bytes: body.toString('base64') }));
  const invoke = () => cli('plugin', 'invoke', 'artifact.provider', 'report-platform', 'put', '--input', input, '--json');
  async function upload() {
    const result = await invoke();
    assert.deepEqual(JSON.parse(result.stdout), { name: 'report.txt', uri: `${origin}/saved` });
    const report = reports.at(-1);
    assert.equal(report.status.active, true);
    assert.equal(report.status.exp - report.status.iat, ttl);
    return report;
  }
  async function replay(report) {
    const response = await fetch(`${origin}/reports`, { method: 'POST', body,
      headers: { authorization: `Bearer ${report.token}` } });
    assert.equal(response.status, 401);
    assert.ok(reports.at(-1).token === report.token);
    assert.equal(reports.at(-1).status.active, false);
    return { active: false, resourceHttp: response.status, checkedAtMs: Date.now() };
  }
  const first = await upload();
  await delay(Math.max(0, first.status.exp * 1000 + 250 - Date.now()));
  const expired = await replay(first);
  assert.ok(expired.checkedAtMs >= first.status.exp * 1000);
  const second = await upload();
  assert.ok(first.token !== second.token);
  const revocation = await tokenAction(metadata.revocation_endpoint, client, second.token);
  assert.equal(revocation.status, 200);
  const revoked = await replay(second);
  assert.ok(revoked.checkedAtMs < second.status.exp * 1000);
  const deletion = await fetch(client.registration_client_uri, { method: 'DELETE',
    headers: { authorization: `Bearer ${client.registration_access_token}` } });
  assert.equal(deletion.status, 204);
  const before = reportRequests;
  await assert.rejects(invoke(), err => err.code === 1 && err.stderr.trim() === 'Operation credential unavailable' && !err.stdout.trim());
  assert.equal(reportRequests, before);
  assert.equal(before, 4);
  assert.deepEqual(grants, Array.from({ length: 2 }, () => ({ grant: 'client_credentials', scope, method: 'Basic', clientMatches: true })));
  assert.deepEqual(refusals, [{ error: 'invalid_client', status: 401 }]);
  const lifetime = report => ({ active: report.status.active, issuedAt: report.status.iat,
    expiresAt: report.status.exp, scope: report.status.scope, resourceHttp: 200 });
  return { observed: new Date().toISOString(), runtime: process.version, release, archiveSha256: process.argv[2],
    provider: 'credential.oauth', entry: 'plugin invoke artifact.provider report-platform put',
    idp: `oidc-provider ${(await readJson('node_modules/oidc-provider/package.json')).version}`, grants,
    expiry: { before: lifetime(first), after: expired },
    revocation: { before: lifetime(second), revocationHttp: revocation.status, after: revoked },
    clientRemoval: { deleteHttp: deletion.status, nextGrant: refusals[0], cliExit: 1, additionalReportRequests: reportRequests - before } };
}

try {
  console.log(JSON.stringify(await qualify()));
} catch (err) {
  console.error('Qualification failed', err.name, err.code ?? '', err.stack?.split('\n').filter(line => line.includes('qualify.mjs:')).at(0)?.trim());
  process.exitCode = 1;
} finally {
  for (const server of servers) { server.closeAllConnections(); server.close(); }
}
