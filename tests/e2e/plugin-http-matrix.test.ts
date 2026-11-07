import { execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type RequestListener, type Server } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const binary = resolve('apps/cli/dist/index.js');
const message = { title: 'Matrix complete', body: 'Local service double only.\n第二行', urgency: 'high' };
const artifactBytes = Buffer.from([0, 255, 13, 10, 65, 128]);
const artifact = { name: 'matrix.bin', mediaType: 'application/octet-stream', bytes: artifactBytes.toString('base64') };
const snapshot = { commit: 'a'.repeat(40), branch: 'matrix', dirty: false };
const scope = 'reports.write';
const accessToken = 'matrix-access-token';
const clientSecret = 'matrix:secret+&value';
const assertion = 'matrix.jwt.assertion';
const token = { access_token: accessToken, token_type: 'Bearer', scope, expires_in: 3600 };

interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  persist?: string;
  hang?: boolean;
}
interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let certificateRoot: string;
let root: string;
let home: string;
let workspace: string;
let http: string;
let https: string;
let environment: NodeJS.ProcessEnv;
let servers: Server[];
let sockets: Set<Socket>;
let requests: RecordedRequest[];
let replies: Reply[];
let fallbackReply: Reply | undefined;
let fixtureErrors: unknown[];
let events: EventEmitter;
let sequence: number;

beforeAll(async () => {
  certificateRoot = await mkdtemp(join(tmpdir(), 'plugin-http-matrix-ca-'));
  const config = join(certificateRoot, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Plugin matrix fixture\n[ext]\nbasicConstraints=critical,CA:TRUE\nsubjectAltName=IP:127.0.0.1,DNS:localhost,DNS:oauth2.googleapis.com,DNS:gmail.googleapis.com\n');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', config,
    '-keyout', join(certificateRoot, 'key.pem'), '-out', join(certificateRoot, 'cert.pem')]);
});

afterAll(async () => { if (certificateRoot) await rm(certificateRoot, { recursive: true, force: true }); });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'plugin-http-matrix-'));
  home = join(root, 'home');
  workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  servers = [];
  sockets = new Set();
  requests = [];
  replies = [];
  fallbackReply = undefined;
  fixtureErrors = [];
  events = new EventEmitter();
  sequence = 0;
  const handler: RequestListener = async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push({ method: request.method!, path: request.url!, headers: request.headers, body });
      const reply = replies.shift() ?? fallbackReply;
      events.emit('request', response);
      if (!reply) throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
      if (reply.hang) return;
      if (reply.persist) await writeFile(reply.persist, body);
      response.writeHead(reply.status ?? 200, { 'content-type': reply.text === undefined ? 'application/json' : 'text/plain', ...reply.headers });
      response.end(reply.text ?? JSON.stringify(reply.json ?? {}));
    } catch (error) {
      fixtureErrors.push(error);
      response.writeHead(500).end();
    }
  };
  const listen = async (server: Server, secure: boolean) => {
    servers.push(server);
    server.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener');
    return `${secure ? 'https' : 'http'}://127.0.0.1:${address.port}`;
  };
  http = await listen(createServer(handler), false);
  https = await listen(createTlsServer({
    key: await readFile(join(certificateRoot, 'key.pem')),
    cert: await readFile(join(certificateRoot, 'cert.pem')),
  }, handler), true);
  environment = {
    PATH: process.env.PATH, HOME: home, USERPROFILE: home, LANG: 'en_US.UTF-8', NO_COLOR: '1',
    NODE_EXTRA_CA_CERTS: join(certificateRoot, 'cert.pem'), AFK_EVENT_STORE_DIR: join(root, 'events'),
    MATRIX_TOKEN: 'matrix-service-token', MATRIX_CLIENT_SECRET: clientSecret,
    MATRIX_ASSERTION: assertion, MATRIX_SUBJECT: 'matrix-subject-token',
  };
});

afterEach(async () => {
  for (const socket of sockets ?? []) socket.destroy();
  await Promise.all((servers ?? []).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  if (root) await rm(root, { recursive: true, force: true });
  expect(fixtureErrors).toEqual([]);
  expect(replies).toEqual([]);
});

const afk = (...args: string[]) => execute(process.execPath, [binary, ...args], { cwd: workspace, env: environment, timeout: 15_000 });
const cli = (...args: string[]) => afk('plugin', ...args);
const settings = () => readFile(join(home, '.afk', 'plugins.yml'), 'utf8');
const inputFile = async (input: unknown) => {
  const file = join(root, `input-${sequence++}.json`);
  await writeFile(file, JSON.stringify(input));
  return file;
};
const configure = async (id: string, config: unknown) => cli('configure', id, '--builtin', '--file', await inputFile(config));
const invocation = async (capability: string, provider: string, operation: string, input: unknown) =>
  cli('invoke', capability, provider, operation, '--input', await inputFile(input), '--json');
const invoke = async (capability: string, provider: string, operation: string, input: unknown) =>
  JSON.parse((await invocation(capability, provider, operation, input)).stdout);
const failure = async (operation: Promise<{ stdout: string; stderr: string }>, error?: RegExp) => operation.then(
  () => { throw new Error('Expected CLI failure'); },
  result => {
    expect(result).toMatchObject({ code: 1 });
    if (error) expect(result.stderr).toMatch(error);
    return result as { stdout: string; stderr: string };
  },
);
const reference = async (kind: 'env' | 'enterprise', name = 'token', variable = 'MATRIX_TOKEN') => {
  if (kind === 'env') return { env: variable };
  await configure('credential.enterprise', { values: { [name]: { env: variable } } });
  return { provider: 'credential.enterprise', name };
};
const checkRequest = (index: number, method: string, path: string, auth: string | undefined, body?: unknown) => {
  const request = requests[index];
  expect(request).toMatchObject({ method, path });
  expect(request.headers.authorization).toBe(auth);
  if (body !== undefined) {
    expect(request.headers['content-type']).toMatch(/^application\/json/);
    expect(JSON.parse(request.body.toString())).toEqual(body);
  } else expect(request.body.length).toBe(0);
  return request;
};
const cycle = async (id: string, capability: string, provider: string, operation: string, input: unknown) => {
  const count = requests.length;
  await cli('disable', id);
  expect(await settings()).toContain('enabled: false');
  await failure(invocation(capability, provider, operation, input), /not registered/);
  expect(requests).toHaveLength(count);
  await cli('enable', id);
  expect(await settings()).not.toContain('enabled: false');
};
const safeSettings = async (...secrets: string[]) => {
  const persisted = await settings();
  const inventory = (await cli('list', '--json')).stdout;
  for (const secret of secrets) {
    expect(persisted).not.toContain(secret);
    expect(inventory).not.toContain(secret);
  }
};

it.each([
  ['feishu', 'env'], ['feishu', 'enterprise'], ['slack', 'env'], ['slack', 'enterprise'],
] as const)('notification.%s delivers using %s references, rejects service failures and survives disable/enable', async (vendor, credentials) => {
  const id = `notification.${vendor}`;
  environment.MATRIX_HOOK = `${http}/hooks/${vendor}/synthetic-secret`;
  const webhook = await reference(credentials, 'webhook', 'MATRIX_HOOK');
  await configure(id, { webhook, channel: 'configured-channel' });
  const success = vendor === 'feishu' ? { json: { code: 0 } } : { text: 'ok' };
  const expectedBody = vendor === 'feishu'
    ? { msg_type: 'text', content: { text: '[HIGH] Matrix complete\nLocal service double only.\n第二行' } }
    : { text: '[HIGH] Matrix complete\nLocal service double only.\n第二行' };
  replies.push(success);
  expect(await invoke('notification.provider', id, 'notify', message)).toEqual({ delivered: true, channel: 'configured-channel' });
  checkRequest(0, 'POST', `/hooks/${vendor}/synthetic-secret`, undefined, expectedBody);
  await safeSettings(environment.MATRIX_HOOK);
  for (const reply of [
    vendor === 'feishu' ? { json: { code: 19001 } } : { text: 'invalid_payload' },
    vendor === 'feishu' ? { json: { code: '0' } } : { text: '' },
    { status: 503, text: environment.MATRIX_HOOK },
    { status: 302, headers: { location: `${http}/must-not-follow` } },
  ]) {
    const count = requests.length;
    replies.push(reply);
    const result = await failure(invocation('notification.provider', id, 'notify', { ...message, channel: 'override' }));
    expect(JSON.parse(result.stdout)).toMatchObject({ delivered: false, channel: 'override', error: expect.any(String) });
    expect(result.stdout + result.stderr).not.toContain(environment.MATRIX_HOOK);
    expect(requests).toHaveLength(count + 1);
    checkRequest(count, 'POST', `/hooks/${vendor}/synthetic-secret`, undefined, expectedBody);
  }
  const previous = await settings();
  await failure(configure(id, { webhook: environment.MATRIX_HOOK }), /configuration|settings/);
  await failure(invocation('notification.provider', id, 'notify', { ...message, urgency: 'urgent' }), /Invalid or unsupported/);
  expect(await settings()).toBe(previous);
  expect(requests).toHaveLength(5);
  await cycle(id, 'notification.provider', id, 'notify', message);
  replies.push(success);
  expect(await invoke('notification.provider', id, 'notify', message)).toEqual({ delivered: true, channel: 'configured-channel' });
  expect(requests).toHaveLength(6);
}, 60_000);

it.each([
  ['linear', 'env'], ['linear', 'enterprise'], ['jira', 'env'], ['jira', 'enterprise'],
] as const)('tracker.%s creates and reads real HTTP issues with %s credentials and rejects bad responses', async (vendor, credentials) => {
  const id = `tracker.${vendor}`;
  const secret = await reference(credentials);
  const email = credentials === 'enterprise' ? 'matrix@example.test' : undefined;
  const config = vendor === 'linear'
    ? { baseUrl: `${http}/linear/graphql`, token: secret, teamId: 'team-matrix' }
    : { baseUrl: `${http}/jira`, token: secret, projectKey: 'MATRIX', email };
  await configure(id, config);
  const raw = vendor === 'linear'
    ? { id: 'linear-uuid', identifier: 'MATRIX-7', title: 'TCP issue', description: 'Created locally', team: { id: 'team-matrix' },
      state: { name: 'Todo' }, labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }, url: `${http}/issue/MATRIX-7` }
    : { id: '10007', key: 'MATRIX-7', fields: { summary: 'TCP issue', description: { type: 'doc', version: 1, content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'Created locally' }] },
    ] }, status: { name: 'Todo' }, labels: [] } };
  const readReply = vendor === 'linear' ? { json: { data: { issue: raw } } } : { json: raw };
  const expected = { id: vendor === 'linear' ? 'linear-uuid' : 'MATRIX-7', key: 'MATRIX-7', projectId: vendor === 'linear' ? 'team-matrix' : 'MATRIX',
    title: 'TCP issue', description: 'Created locally', state: 'Todo', labels: [], url: vendor === 'linear' ? `${http}/issue/MATRIX-7` : `${http}/jira/browse/MATRIX-7` };
  const auth = vendor === 'linear' ? environment.MATRIX_TOKEN! : email
    ? `Basic ${Buffer.from(`${email}:${environment.MATRIX_TOKEN}`).toString('base64')}` : `Bearer ${environment.MATRIX_TOKEN}`;
  const input = { title: 'TCP issue', description: 'Created locally' };
  if (vendor === 'linear') replies.push({ json: { data: { issueCreate: { success: true, issue: raw } } } });
  else replies.push({ status: 201, json: { id: '10007', key: 'MATRIX-7' } }, readReply);
  expect(await invoke('tracker.issue', vendor, 'createIssue', input)).toEqual(expected);
  if (vendor === 'linear') {
    const request = requests[0];
    expect(request).toMatchObject({ method: 'POST', path: '/linear/graphql' });
    expect(request.headers.authorization).toBe(auth);
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body.toString())).toEqual({ query: expect.stringContaining('mutation CreateIssue'), variables: { input: { teamId: 'team-matrix', ...input } } });
  } else {
    checkRequest(0, 'POST', '/jira/rest/api/3/issue', auth, { fields: { project: { key: 'MATRIX' }, summary: input.title,
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: input.description }] }] }, issuetype: { name: 'Task' } } });
    checkRequest(1, 'GET', '/jira/rest/api/3/issue/MATRIX-7?fields=summary,description,labels,status', auth);
  }
  const issueInput = { issueId: 'MATRIX-7' };
  const count = requests.length;
  replies.push(readReply);
  expect(await invoke('tracker.issue', vendor, 'getIssue', issueInput)).toEqual(expected);
  if (vendor === 'linear') checkRequest(count, 'POST', '/linear/graphql', auth, {
    query: expect.stringContaining('query GetIssue'), variables: { id: 'MATRIX-7' },
  });
  else checkRequest(count, 'GET', '/jira/rest/api/3/issue/MATRIX-7?fields=summary,description,labels,status', auth);
  for (const reply of [{ status: 401, text: 'denied' }, { json: {} }, { text: '{broken' },
    vendor === 'linear' ? { json: { errors: [{ message: 'rejected' }] } } : { json: { errorMessages: ['rejected'] } },
  ]) {
    replies.push(reply);
    await failure(invocation('tracker.issue', vendor, 'getIssue', issueInput), /HTTP 401|expected schema|invalid.*JSON|error payload/);
  }
  const before = requests.length;
  await failure(invocation('tracker.issue', vendor, 'createIssue', { title: '' }), /Invalid or unsupported/);
  expect(requests).toHaveLength(before);
  await safeSettings(environment.MATRIX_TOKEN!);
  await cycle(id, 'tracker.issue', vendor, 'getIssue', issueInput);
  replies.push(readReply);
  expect(await invoke('tracker.issue', vendor, 'getIssue', issueInput)).toEqual(expected);
  expect(requests).toHaveLength(before + 1);
}, 60_000);

it('context.knowledge-base posts queries, limits valid fragments and rejects invalid input, payloads and outages', async () => {
  const id = 'context.knowledge-base';
  const query = { scope: 'matrix/repository', prompt: 'TCP knowledge', limit: 1 };
  const fragments = [{ content: 'First answer', origin: 'kb:one', score: 0.9 }, { content: 'Second answer', origin: 'kb:two' }];
  await configure(id, { endpoint: `${http}/knowledge/search` });
  replies.push({ json: fragments });
  expect(await invoke('context.provider', id, 'gather', query)).toEqual(fragments.slice(0, 1));
  checkRequest(0, 'POST', '/knowledge/search', undefined, query);
  for (const [reply, error] of [
    [{ json: { fragments } }, /invalid response/], [{ json: [{ content: 'missing origin' }] }, /invalid fragment/],
    [{ text: 'not JSON' }, /invalid JSON/], [{ status: 503 }, /503/],
  ] as const) {
    replies.push(reply);
    await failure(invocation('context.provider', id, 'gather', query), error);
  }
  const before = requests.length;
  await failure(invocation('context.provider', id, 'gather', { ...query, limit: 0 }), /Invalid or unsupported/);
  await failure(invocation('context.provider', id, 'remember', fragments[0]), /Invalid or unsupported/);
  expect(requests).toHaveLength(before);
  await cycle(id, 'context.provider', id, 'gather', query);
  replies.push({ json: fragments });
  expect(await invoke('context.provider', id, 'gather', query)).toEqual(fragments.slice(0, 1));
  expect(requests).toHaveLength(before + 1);
}, 60_000);

it.each(['object-storage', 'report-env', 'report-enterprise'] as const)('artifact.%s uploads and persists exact binary bytes, validates references and honors lifecycle', async vendor => {
  const objectStorage = vendor === 'object-storage';
  const provider = objectStorage ? 'object-storage' : 'report-platform';
  const id = `artifact.${provider}`;
  const secret = objectStorage ? undefined : await reference(vendor === 'report-env' ? 'env' : 'enterprise');
  const endpoint = objectStorage ? `${http}/objects` : `${https}/reports`;
  await configure(id, { endpoint, ...(secret ? { token: secret } : {}) });
  const file = join(root, 'uploaded.bin');
  const uri = `${http}/download/matrix.bin`;
  replies.push({ json: { uri: `${uri}?signature=never-persist#fragment` }, persist: file });
  expect(await invoke('artifact.provider', provider, 'put', artifact)).toEqual({ uri, name: artifact.name });
  expect(await readFile(file)).toEqual(artifactBytes);
  const request = requests[0];
  expect(request).toMatchObject({ method: objectStorage ? 'PUT' : 'POST', path: objectStorage ? '/objects/matrix.bin' : '/reports' });
  expect(request.headers.authorization).toBe(objectStorage ? undefined : `Bearer ${environment.MATRIX_TOKEN}`);
  expect(request.headers['content-type']).toBe(artifact.mediaType);
  expect(request.body).toEqual(artifactBytes);
  for (const [reply, error] of [[{ status: 503 }, /503/], [{ json: { uri: 'file:///private/invalid' } }, /invalid artifact URI|valid artifact URI/]] as const) {
    replies.push(reply);
    await failure(invocation('artifact.provider', provider, 'put', artifact), error);
    expect(await readFile(file)).toEqual(artifactBytes);
  }
  await failure(invocation('artifact.provider', provider, 'put', { ...artifact, name: '../escape.bin' }), /unsafe artifact name/);
  await failure(invocation('artifact.provider', provider, 'put', { ...artifact, bytes: 'not-base64!' }), /Invalid or unsupported/);
  expect(requests).toHaveLength(3);
  await cycle(id, 'artifact.provider', provider, 'put', artifact);
  replies.push(objectStorage ? { status: 204, text: '' } : { json: { url: uri } });
  expect(await invoke('artifact.provider', provider, 'put', artifact)).toEqual({ uri: objectStorage ? `${endpoint}/matrix.bin` : uri, name: artifact.name });
  expect(requests).toHaveLength(4);
  if (secret) await safeSettings(environment.MATRIX_TOKEN!);
}, 60_000);

it.each(['none', 'env', 'enterprise'] as const)('repository.remote-workspace snapshots using %s authentication and rejects invalid responses', async credentials => {
  const id = 'repository.remote-workspace';
  const secret = credentials === 'none' ? undefined : await reference(credentials);
  const baseUrl = `${secret ? https : http}/api`;
  await configure(id, { baseUrl, ...(secret ? { token: secret } : {}) });
  const input = { url: 'team/repo with space' };
  replies.push({ json: snapshot });
  expect(await invoke('repository.provider', 'remote-workspace', 'snapshot', input)).toEqual(snapshot);
  checkRequest(0, 'GET', '/api/workspaces/team%2Frepo%20with%20space/snapshot', secret ? `Bearer ${environment.MATRIX_TOKEN}` : undefined);
  for (const [reply, error] of [
    [{ status: 403 }, /403/], [{ text: '{broken' }, /invalid JSON/], [{ json: { ...snapshot, dirty: 'false' } }, /dirty flag/],
  ] as const) {
    replies.push(reply);
    await failure(invocation('repository.provider', 'remote-workspace', 'snapshot', input), error);
  }
  await failure(invocation('repository.provider', 'remote-workspace', 'snapshot', { url: '' }), /Invalid or unsupported/);
  expect(requests).toHaveLength(4);
  await cycle(id, 'repository.provider', 'remote-workspace', 'snapshot', input);
  replies.push({ json: snapshot });
  expect(await invoke('repository.provider', 'remote-workspace', 'snapshot', input)).toEqual(snapshot);
  expect(requests).toHaveLength(5);
  if (secret) await safeSettings(environment.MATRIX_TOKEN!);
}, 60_000);

it.each(['repository.remote-workspace', 'artifact.report-platform'] as const)('%s refuses bearer credentials over cleartext HTTP without sending a request', async id => {
  await configure(id, { [id.startsWith('repository') ? 'baseUrl' : 'endpoint']: http, token: { env: 'MATRIX_TOKEN' } });
  await failure(invocation(id.startsWith('repository') ? 'repository.provider' : 'artifact.provider', id.split('.')[1],
    id.startsWith('repository') ? 'snapshot' : 'put', id.startsWith('repository') ? { url: 'fixture' } : artifact), /requires HTTPS/);
  expect(requests).toHaveLength(0);
});

it.each(['client_secret_basic', 'client_secret_post'] as const)('credential.oauth resolves %s through a real authenticated artifact consumer', async authMethod => {
  const secret = await reference(authMethod === 'client_secret_basic' ? 'env' : 'enterprise', 'client', 'MATRIX_CLIENT_SECRET');
  await configure('credential.oauth', { tokenEndpoint: `${https}/oauth/token`, clientId: 'matrix client+id', clientSecret: secret, authMethod, timeoutMs: 1000 });
  await configure('artifact.report-platform', { endpoint: `${https}/reports`, token: { provider: 'credential.oauth', name: 'reports', scope } });
  replies.push({ json: token }, { json: { uri: `${https}/report/7` } });
  expect(await invoke('artifact.provider', 'report-platform', 'put', artifact)).toEqual({ uri: `${https}/report/7`, name: artifact.name });
  const request = requests[0];
  expect(request).toMatchObject({ method: 'POST', path: '/oauth/token' });
  expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
  expect(request.headers.accept).toBe('application/json');
  expect(Object.fromEntries(new URLSearchParams(request.body.toString()))).toEqual({ grant_type: 'client_credentials', scope,
    ...(authMethod === 'client_secret_post' ? { client_id: 'matrix client+id', client_secret: clientSecret } : {}) });
  const encode = (value: string) => new URLSearchParams({ value }).toString().slice(6);
  expect(request.headers.authorization).toBe(authMethod === 'client_secret_basic'
    ? `Basic ${Buffer.from(`${encode('matrix client+id')}:${encode(clientSecret)}`).toString('base64')}` : undefined);
  expect(requests[1]).toMatchObject({ method: 'POST', path: '/reports', body: artifactBytes });
  expect(requests[1].headers.authorization).toBe(`Bearer ${accessToken}`);
  await failure(cli('disable', 'credential.oauth'), /artifact.report-platform/);
  await cli('disable', 'artifact.report-platform');
  await cli('disable', 'credential.oauth');
  await failure(invocation('artifact.provider', 'report-platform', 'put', artifact), /not registered/);
  await cli('enable', 'credential.oauth');
  await cli('enable', 'artifact.report-platform');
  replies.push({ json: token }, { json: { uri: `${https}/report/8` } });
  expect(await invoke('artifact.provider', 'report-platform', 'put', artifact)).toMatchObject({ uri: `${https}/report/8` });
  expect(requests).toHaveLength(4);
  for (const [reply, error] of [
    [{ status: 400, json: { error: 'invalid_client' } }, /not registered/],
    [{ json: { ...token, scope: 'unrelated' } }, /not registered/],
    [{ json: { ...token, token_type: 'MAC' } }, /not registered/],
    [{ text: 'broken-json' }, /not registered/],
    [{ hang: true }, /not registered/],
  ] as const) {
    const count = requests.length;
    replies.push(reply);
    const result = await failure(invocation('artifact.provider', 'report-platform', 'put', artifact), error);
    expect(requests).toHaveLength(count + 1);
    expect(result.stdout + result.stderr).not.toContain(clientSecret);
    expect(result.stdout + result.stderr).not.toContain(accessToken);
  }
  await cli('disable', 'artifact.report-platform');
  const count = requests.length;
  await failure(invocation('credential.provider', 'credential.oauth', 'resolve', { name: 'reports', scope }), /credential operations are private/);
  expect(requests).toHaveLength(count);
  await safeSettings(clientSecret, accessToken);
}, 60_000);

it.each([false, true])('credential.oidc discovers and pins its endpoint, exchanges=%s, and authenticates the consumer', async exchange => {
  const secret = await reference(exchange ? 'enterprise' : 'env', 'assertion', 'MATRIX_ASSERTION');
  const issuer = `${https}/oidc`;
  const tokenEndpoint = `${https}/oidc/token`;
  const config = { issuer, clientId: 'matrix-client', assertion: secret, tokenEndpoint, timeoutMs: 1000,
    ...(exchange ? { exchange: { subjectToken: { env: 'MATRIX_SUBJECT' }, subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt', audience: 'reports', resource: `${https}/reports` } } : {}) };
  await configure('credential.oidc', config);
  await configure('artifact.report-platform', { endpoint: `${https}/reports`, token: { provider: 'credential.oidc', name: 'report-token', scope } });
  const metadata = { issuer, token_endpoint: tokenEndpoint };
  const issued = { ...token, ...(exchange ? { issued_token_type: 'urn:ietf:params:oauth:token-type:access_token' } : {}) };
  replies.push({ json: metadata }, { json: issued }, { json: { uri: `${https}/reports/oidc` } });
  expect(await invoke('artifact.provider', 'report-platform', 'put', artifact)).toEqual({ uri: `${https}/reports/oidc`, name: artifact.name });
  checkRequest(0, 'GET', '/oidc/.well-known/openid-configuration', undefined);
  expect(requests[0].headers.accept).toBe('application/json');
  expect(requests[1]).toMatchObject({ method: 'POST', path: '/oidc/token' });
  expect(requests[1].headers.authorization).toBeUndefined();
  expect(requests[1].headers['content-type']).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(new URLSearchParams(requests[1].body.toString()))).toEqual({
    grant_type: exchange ? 'urn:ietf:params:oauth:grant-type:token-exchange' : 'client_credentials', client_id: 'matrix-client',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer', client_assertion: assertion, scope,
    ...(exchange ? { subject_token: environment.MATRIX_SUBJECT, subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token', audience: 'reports', resource: `${https}/reports` } : {}),
  });
  expect(requests[2]).toMatchObject({ method: 'POST', path: '/reports', body: artifactBytes });
  expect(requests[2].headers.authorization).toBe(`Bearer ${accessToken}`);
  for (const badMetadata of [{ ...metadata, issuer: `${https}/wrong-issuer` }, { ...metadata, token_endpoint: `${https}/wrong-token` },
    { ...metadata, token_endpoint: `${http}/insecure-token` }]) {
    const count = requests.length;
    replies.push({ json: badMetadata });
    await failure(invocation('artifact.provider', 'report-platform', 'put', artifact), /not registered/);
    expect(requests).toHaveLength(count + 1);
  }
  replies.push({ json: metadata }, { json: { ...issued, scope: 'wrong', access_token: 'invalid token' } });
  await failure(invocation('artifact.provider', 'report-platform', 'put', artifact), /not registered/);
  await cli('disable', 'artifact.report-platform');
  await cli('disable', 'credential.oidc');
  await failure(invocation('artifact.provider', 'report-platform', 'put', artifact), /not registered/);
  await cli('enable', 'credential.oidc');
  await cli('enable', 'artifact.report-platform');
  replies.push({ json: metadata }, { json: issued }, { json: { uri: `${https}/reports/re-enabled` } });
  expect(await invoke('artifact.provider', 'report-platform', 'put', artifact)).toMatchObject({ uri: `${https}/reports/re-enabled` });
  await cli('disable', 'artifact.report-platform');
  await safeSettings(assertion, accessToken, environment.MATRIX_SUBJECT!);
}, 60_000);

it('disabling a configured OAuth consumer validates metadata without authenticating it', async () => {
  await configure('credential.oauth', {
    tokenEndpoint: `${https}/oauth/token`, clientId: 'matrix-client', clientSecret: { env: 'MATRIX_CLIENT_SECRET' },
  });
  await configure('artifact.report-platform', { endpoint: `${https}/reports`, token: { provider: 'credential.oauth', name: 'reports', scope } });
  fallbackReply = { json: token };
  await cli('disable', 'artifact.report-platform');
  expect(await settings()).toContain('enabled: false');
  expect(requests, 'docs/architecture/plugins.md: the mutation guard must not call credential operations').toHaveLength(0);
  await cli('enable', 'artifact.report-platform');
  await cli('enable', 'artifact.report-platform');
  expect(requests).toHaveLength(0);
});

it('metadata management avoids OAuth activation and graph generation honors disabled consumers', async () => {
  await failure(cli('enable', 'context.missing'), /Plugin 'context.missing' is not installed/);
  await expect(settings()).rejects.toMatchObject({ code: 'ENOENT' });
  await configure('credential.oauth', {
    tokenEndpoint: `${https}/oauth/token`, clientId: 'matrix-client', clientSecret: { env: 'MATRIX_CLIENT_SECRET' },
  });
  await configure('artifact.report-platform', { endpoint: `${https}/reports`, token: { provider: 'credential.oauth', name: 'reports', scope } });
  fallbackReply = { json: token };
  expect((await afk('--help')).stdout).toContain('Usage: afk');
  expect((await cli('--help')).stdout).toContain('Usage: afk plugin');
  await configure('context.retrieval', { documents: [{ origin: 'fixture', content: 'metadata only' }] });
  const extension = join(root, 'extension');
  await mkdir(extension);
  const id = 'context.metadata-fixture';
  await writeFile(join(extension, 'package.json'), JSON.stringify({ name: 'metadata-fixture', version: '1.0.0', type: 'module' }));
  await writeFile(join(extension, 'plugin.json'), JSON.stringify({ id, version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true, entry: 'index.js' }));
  await writeFile(join(extension, 'index.js'), 'throw new Error("Metadata commands must not import this plugin");');
  await cli('install', extension);
  await cli('disable', id);
  await cli('enable', id);
  await cli('remove', id);
  await expect(readFile(join(home, '.afk', 'plugins', id, 'install.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(requests).toHaveLength(0);
  await cli('disable', 'artifact.report-platform');
  const workflows = join(home, '.afk', 'workflows');
  await mkdir(workflows, { recursive: true });
  await writeFile(join(workflows, 'matrix.yml'), 'name: matrix\nversion: 1\nsteps:\n  - id: implement\n    role: implementer\n    prompt: local graph fixture\n');
  const graph = JSON.parse((await afk('graph', 'workflow', 'matrix', '--project', workspace, '--format', 'json')).stdout);
  expect(graph.nodes).toHaveLength(1);
  expect(JSON.parse(await readFile(graph.cache.graphPath, 'utf8')).nodes).toEqual(graph.nodes);
  expect(requests).toHaveLength(0);
}, 60_000);

it.each(['credential.oauth', 'credential.oidc'] as const)('%s rejects insecure endpoint configuration and missing environment references without HTTP', async id => {
  const valid = id === 'credential.oauth'
    ? { tokenEndpoint: `${https}/token`, clientId: 'fixture', clientSecret: { env: 'MATRIX_CLIENT_SECRET' } }
    : { issuer: `${https}/oidc`, clientId: 'fixture', assertion: { env: 'MATRIX_ASSERTION' } };
  await configure(id, valid);
  const previous = await settings();
  await failure(configure(id, { ...valid, [id === 'credential.oauth' ? 'tokenEndpoint' : 'issuer']: http }), /configuration|settings/);
  await failure(configure(id, { ...valid, [id === 'credential.oauth' ? 'clientSecret' : 'assertion']: { env: 'MATRIX_NOT_SET' } }), /configuration|settings/);
  expect(await settings()).toBe(previous);
  expect(requests).toHaveLength(0);
});

it('cancels a CLI process during a real pending HTTP request and can invoke again with persisted settings', async () => {
  await configure('repository.remote-workspace', { baseUrl: http });
  const previous = await settings();
  replies.push({ hang: true });
  const arrived = once(events, 'request');
  const pending = cli('invoke', 'repository.provider', 'remote-workspace', 'snapshot', '--input', await inputFile({ url: 'cancel-fixture' }), '--json');
  const outcome = pending.then(() => { throw new Error('Cancelled invocation unexpectedly succeeded'); }, error => error);
  const [response] = await Promise.race([arrived, outcome.then(error => { throw error; })]);
  const closed = once(response, 'close');
  expect(pending.child.kill('SIGTERM')).toBe(true);
  expect(await outcome).toMatchObject({ signal: 'SIGTERM', stdout: '' });
  await closed;
  checkRequest(0, 'GET', '/workspaces/cancel-fixture/snapshot', undefined);
  expect(await settings()).toBe(previous);
  replies.push({ json: snapshot });
  expect(await invoke('repository.provider', 'remote-workspace', 'snapshot', { url: 'cancel-fixture' })).toEqual(snapshot);
  expect(requests).toHaveLength(2);
});

it('notification.gmail refreshes a synthetic OAuth fixture, sends MIME over loopback TLS and persists the refreshed session', async () => {
  const bin = join(root, 'bin');
  await mkdir(bin);
  const keychain = join(root, 'oauth-session');
  const shim = `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.MATRIX_KEYCHAIN;
const mac = process.argv.includes('JavaScript');
const action = mac ? process.argv[6] : process.argv[2];
if (action === 'read' || action === 'lookup') {
  if (!fs.existsSync(file)) { if (mac) process.stdout.write(JSON.stringify({ missing: true })); else process.exitCode = 1; }
  else { const value = fs.readFileSync(file, 'utf8'); process.stdout.write(mac ? JSON.stringify({ value }) : value); }
} else if (action === 'write' || action === 'store') {
  let input = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => { fs.writeFileSync(file, input); if (mac) process.stdout.write(JSON.stringify({ ok: true })); });
} else { throw new Error('Unexpected fixture keychain operation'); }
`;
  for (const command of ['osascript', 'secret-tool']) {
    const file = join(bin, command);
    await writeFile(file, shim);
    await chmod(file, 0o755);
  }
  const session = { subject: 'fixture-subject', email: 'sender@example.test', clientId: 'matrix.apps.googleusercontent.com', clientSecret: 'google-fixture-secret',
    accessToken: 'expired-fixture', refreshToken: 'fixture-refresh-token', expiresAt: Date.now() - 1000,
    scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.send'] };
  await writeFile(keychain, Buffer.from(JSON.stringify(session)).toString('base64url'));
  const tunnels: string[] = [];
  servers[0].on('connect', (request, socket, head) => {
    tunnels.push(request.url!);
    if (!['oauth2.googleapis.com:443', 'gmail.googleapis.com:443'].includes(request.url!)) {
      socket.destroy();
      fixtureErrors.push(new Error(`Unexpected proxy destination: ${request.url}`));
      return;
    }
    const upstream = connect(Number(new URL(https).port), '127.0.0.1');
    sockets.add(upstream);
    upstream.on('error', error => { fixtureErrors.push(error); socket.destroy(); });
    upstream.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => { sockets.delete(upstream); socket.destroy(); });
  });
  environment = { ...environment, PATH: `${bin}:${environment.PATH}`, MATRIX_KEYCHAIN: keychain, HTTP_PROXY: http, HTTPS_PROXY: http, NO_PROXY: '' };
  await configure('notification.gmail', { to: 'recipient@example.test', channel: 'fixture-gmail' });
  replies.push({ json: { access_token: 'gmail-fixture-access', token_type: 'Bearer', expires_in: 3600, scope: session.scopes.join(' ') } }, { json: { id: 'mail-7' } });
  expect(await invoke('notification.provider', 'notification.gmail', 'notify', message)).toEqual({ delivered: true, channel: 'fixture-gmail' });
  expect(tunnels).toEqual(['oauth2.googleapis.com:443', 'gmail.googleapis.com:443']);
  expect(requests[0]).toMatchObject({ method: 'POST', path: '/token' });
  expect(requests[0].headers.authorization).toBeUndefined();
  expect(requests[0].headers['content-type']).toBe('application/x-www-form-urlencoded');
  expect(Object.fromEntries(new URLSearchParams(requests[0].body.toString()))).toEqual({ grant_type: 'refresh_token',
    refresh_token: session.refreshToken, client_id: session.clientId, client_secret: session.clientSecret });
  const request = requests[1];
  expect(request).toMatchObject({ method: 'POST', path: '/gmail/v1/users/me/messages/send' });
  expect(request.headers.authorization).toBe('Bearer gmail-fixture-access');
  expect(request.headers['content-type']).toBe('application/json');
  const mime = Buffer.from(JSON.parse(request.body.toString()).raw, 'base64url').toString();
  expect(mime).toContain('From: sender@example.test\r\nTo: recipient@example.test\r\n');
  expect(mime).toContain(`Subject: =?UTF-8?B?${Buffer.from(message.title).toString('base64')}?=`);
  expect(mime).toContain('Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64');
  expect(Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString()).toBe(message.body);
  const persisted = JSON.parse(Buffer.from(await readFile(keychain, 'utf8'), 'base64url').toString());
  expect(persisted).toMatchObject({ ...session, accessToken: 'gmail-fixture-access', expiresAt: expect.any(Number) });
  expect(persisted.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  for (const [reply, error] of [[{ status: 403 }, /access was denied/], [{ json: {} }, /could not accept/]] as const) {
    replies.push(reply);
    const failed = await failure(invocation('notification.provider', 'notification.gmail', 'notify', message));
    expect(JSON.parse(failed.stdout)).toMatchObject({ delivered: false, channel: 'fixture-gmail', error: expect.stringMatching(error) });
  }
  await cycle('notification.gmail', 'notification.provider', 'notification.gmail', 'notify', message);
  replies.push({ json: { id: 'mail-re-enabled' } });
  expect(await invoke('notification.provider', 'notification.gmail', 'notify', message)).toMatchObject({ delivered: true });
  const count = requests.length;
  const rejected = await failure(invocation('notification.provider', 'notification.gmail', 'notify', { ...message, title: 'Injected\r\nBcc: unwanted@example.test' }));
  expect(JSON.parse(rejected.stdout).delivered).toBe(false);
  expect(requests).toHaveLength(count);
  await safeSettings(session.clientSecret, session.refreshToken, 'gmail-fixture-access');
}, 60_000);
