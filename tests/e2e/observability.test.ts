import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const execute = promisify(execFile);
const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

it('loads CLI-configured OTLP into managed execution, isolates collector failure and honors disable/enable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observability-e2e-'));
  directories.push(root);
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const requests: { path: string; authorization?: string; body: any }[] = [];
  let status = 200;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push({ path: request.url!, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(status === 200 ? '{}' : '{"error":"collector unavailable"}');
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP listener');
  const settings = join(root, 'observability.json');
  await writeFile(settings, JSON.stringify({
    endpoint: `http://127.0.0.1:${address.port}`, serviceName: 'observability-e2e',
    headers: { authorization: { env: 'OBSERVABILITY_E2E_AUTH' } }, timeoutMs: 1000,
  }));
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, AFK_EVENT_STORE_DIR: join(root, 'events'),
    OBSERVABILITY_E2E_AUTH: 'Bearer local-e2e-fixture', WORKSPACE_E2E: workspace,
  };
  const cli = (...args: string[]) => execute(process.execPath, [resolve('apps/cli/dist/index.js'), 'plugin', ...args], { cwd: workspace, env, timeout: 15_000 });
  await cli('configure', 'observability.otlp', '--builtin', '--file', settings);
  const inventory = await cli('list', '--json');
  expect(inventory.stdout).toContain('observability.otlp');
  expect(inventory.stdout).not.toContain(env.OBSERVABILITY_E2E_AUTH);
  const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(resolve(`packages/runtime/dist/${path}.js`)).href);
  const script = join(root, 'managed-run.mjs');
  await writeFile(script, `
    import { createDefaultPluginRuntime } from ${moduleUrl('plugin-sdk/index')};
    import { executeWorkItem } from ${moduleUrl('application/workflows/execute-work-item')};
    import { JsonlEventStore } from ${moduleUrl('infrastructure/observability/jsonl-event-store')};
    const workspaceRoot = process.env.WORKSPACE_E2E;
    const workItemId = 'github:acme/api#42';
    const executionId = process.argv[2];
    const plugins = await createDefaultPluginRuntime({ homeDir: process.env.HOME, workspaceRoot });
    const item = {
      id: workItemId, workItemId, issueNumber: 42,
      project: { platform: 'github', projectKey: 'acme/api', name: 'api' },
      managed: true, executionEligible: true, title: 'Observe', dependsOn: [],
      state: 'ready', executionMode: 'afk', tags: [], branchName: 'feature/42', providerRef: workItemId,
    };
    try {
      const result = await executeWorkItem({ workItemId, executionId, manifestPath: workspaceRoot + '/manifest.json' }, {
        plugins,
        lookupWorkItem: async () => item,
        readManifest: async () => ({ workItemId, providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'acme/api' }, workspaceRoot, manifestPath: workspaceRoot + '/manifest.json' }),
        createContext: async () => ({
          providers: { backlog: { get: async () => item, isRunnable: async () => true, claim: async () => null, setExecutionMode: async () => undefined }, branches: {}, changes: { findForBacklog: async () => null } },
          request: { backlogId: '42', workspaceRoot, repoRoot: workspaceRoot, agentRuntime: { kind: 'default' }, targetBranch: 'main' },
        }),
      });
      const integrity = await new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR }).verify(executionId);
      console.log('OBSERVABILITY_RESULT=' + JSON.stringify({ result, integrity }));
    } finally { await plugins.dispose(); }
  `);
  const run = async (id: string) => {
    const result = await execute(process.execPath, [script, id], { cwd: workspace, env, timeout: 15_000 });
    const report = result.stdout.split('\n').find(line => line.startsWith('OBSERVABILITY_RESULT='));
    if (!report) throw new Error('Managed execution did not report its result');
    const parsed = JSON.parse(report.slice('OBSERVABILITY_RESULT='.length));
    expect(parsed.result).toMatchObject({ status: 'not_claimed', executionId: id });
    expect(parsed.integrity).toMatchObject({ valid: true, lastSequence: expect.any(Number) });
    expect(parsed.integrity.lastSequence).toBeGreaterThan(0);
  };
  await run('observability-healthy');
  const traceRequests = requests.filter(request => request.path === '/v1/traces');
  const metricRequests = requests.filter(request => request.path === '/v1/metrics');
  expect(traceRequests.length).toBeGreaterThan(0);
  expect(metricRequests.length).toBeGreaterThan(0);
  expect(requests.every(request => request.authorization === env.OBSERVABILITY_E2E_AUTH)).toBe(true);
  const traces = traceRequests.flatMap(request => request.body.resourceSpans);
  expect(traces[0].resource.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'observability-e2e' } });
  const spans = traces.flatMap(resource => resource.scopeSpans.flatMap((scope: any) => scope.spans));
  expect(spans.some(span => span.attributes.some((attribute: any) => attribute.key === 'work_item_id' && attribute.value.stringValue === 'github:acme/api#42'))).toBe(true);
  expect(spans.every(span => /^[a-f0-9]{32}$/.test(span.traceId) && /^[a-f0-9]{16}$/.test(span.spanId))).toBe(true);
  const metrics = metricRequests.flatMap(request => request.body.resourceMetrics.flatMap((resource: any) => resource.scopeMetrics.flatMap((scope: any) => scope.metrics)));
  expect(metrics.some(metric => metric.name === 'afk.run_events_total' && metric.sum)).toBe(true);
  expect(metrics.some(metric => metric.name === 'run.event_persistence_ms' && metric.histogram)).toBe(true);

  status = 503;
  await run('observability-offline');
  status = 200;
  await cli('disable', 'observability.otlp');
  const disabledCount = requests.length;
  await run('observability-disabled');
  expect(requests).toHaveLength(disabledCount);
  await cli('enable', 'observability.otlp');
  await run('observability-enabled');
  expect(requests.length).toBeGreaterThan(disabledCount);
});
