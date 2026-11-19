import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  const cli = (...args: string[]) => execute(process.execPath, [resolve(process.env.AFK_E2E_CLI_ENTRY ?? 'apps/cli/dist/index.js'), 'plugin', ...args], { cwd: workspace, env, timeout: 15_000 });
  await cli('configure', 'observability.otlp', '--builtin', '--file', settings);
  const inventory = await cli('list', '--json');
  expect(inventory.stdout).toContain('observability.otlp');
  expect(inventory.stdout).not.toContain(env.OBSERVABILITY_E2E_AUTH);
  const runtime = resolve(process.env.AFK_E2E_RUNTIME_ROOT ?? 'packages/runtime/dist');
  const script = resolve('tests/e2e/observability-managed-run.mjs');
  const run = async (id: string) => {
    const result = await execute(process.execPath, [script, id], { cwd: workspace, env: { ...env, AFK_E2E_RUNTIME_ROOT: runtime }, timeout: 15_000 });
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

it('mirrors audit evidence only to the selected store and keeps local evidence on readback mismatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'observability-evidence-e2e-'));
  directories.push(root);
  const home = join(root, 'home');
  const extension = join(root, 'extension');
  const callsPath = join(root, 'evidence-calls.jsonl');
  await Promise.all([mkdir(home), mkdir(extension)]);
  await writeFile(callsPath, '');
  const env = {
    PATH: '/usr/bin:/bin', HOME: home, USERPROFILE: home, AFK_EVENT_STORE_DIR: join(root, 'events'),
    EVIDENCE_CALLS: callsPath,
  };
  const manifest = { id: 'evidence.fixture', version: '1.0.0', apiVersion: 1, provides: ['observe.evidence'], trusted: true, entry: 'index.js' };
  await writeFile(join(extension, 'package.json'), JSON.stringify({ name: 'evidence-fixture', version: '1.0.0', type: 'module' }));
  await writeFile(join(extension, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(join(extension, 'index.js'), `
    import { appendFile } from 'node:fs/promises';
    export default { manifest: ${JSON.stringify(manifest)}, activate(setup) {
      for (const name of ['primary', 'unused']) {
        let stored;
        async function record(operation, id, bytes) {
          await appendFile(process.env.EVIDENCE_CALLS, JSON.stringify({ name, operation, id, bytes: Buffer.from(bytes).toString('base64') }) + '\\n');
        }
        setup.registerCapability('observe.evidence', name, {
          id: name, capabilities: { put: true, get: true, classify: false },
          async put(input) {
            stored = { ...input, bytes: Buffer.from(input.bytes) };
            await record('put', input.id, stored.bytes);
            return { name: input.id, uri: 'fixture://' + input.id };
          },
          async get(id) {
            const bytes = process.env.EVIDENCE_MISMATCH === '1' ? Buffer.from('mismatched-fixture-bytes') : stored.bytes;
            await record('get', id, bytes);
            return { ...stored, bytes };
          },
        });
      }
    } };
  `);
  const cliEntry = resolve(process.env.AFK_E2E_CLI_ENTRY ?? 'apps/cli/dist/index.js');
  await execute(process.execPath, [cliEntry, 'plugin', 'install', extension], { cwd: root, env, timeout: 15_000 });
  const runtime = resolve(process.env.AFK_E2E_RUNTIME_ROOT ?? 'packages/runtime/dist');
  const moduleUrl = (path: string) => JSON.stringify(pathToFileURL(join(runtime, `${path}.js`)).href);
  const script = join(root, 'evidence-run.mjs');
  await writeFile(script, `
    import { createDefaultPluginRuntime } from ${moduleUrl('plugin-sdk/index')};
    import { createPluginRunObserver } from ${moduleUrl('application/plugins/observability')};
    import { JsonlEventStore } from ${moduleUrl('infrastructure/observability/jsonl-event-store')};
    import { createLocalEncryptedEvidenceStore } from ${moduleUrl('infrastructure/observability/local-evidence-store')};
    const [runId, workItemId, mode] = process.argv.slice(2);
    const eventsRoot = process.env.AFK_EVENT_STORE_DIR;
    if (mode === 'write') {
      const plugins = await createDefaultPluginRuntime({ homeDir: process.env.HOME });
      try {
        const observer = createPluginRunObserver(plugins, eventsRoot);
        const context = { runId, workItemId, traceId: runId, profileId: 'local', attempt: 1, actor: { kind: 'cli', id: 'fixture' } };
        await observer.record(context, { kind: 'run.requested', run: { id: runId, workItemId, profileId: 'local', attempt: 1, status: 'pending' } });
        await observer.record(context, { kind: 'run.started' });
        await observer.record(context, { kind: 'run.finished', outcome: 'succeeded' });
      } finally { await plugins.dispose(); }
    } else {
      const audit = new JsonlEventStore({ root: eventsRoot });
      const events = [];
      for await (const event of audit.read(runId)) events.push(event);
      const ref = events.find(event => event.type === 'run.finished').evidence?.[0];
      const localBytes = ref && Buffer.from(await (await createLocalEncryptedEvidenceStore(process.env.HOME)).get(ref)).toString('base64');
      console.log(JSON.stringify({ events, integrity: await audit.verify(runId), localBytes }));
    }
  `);
  const run = async (runId: string, workItemId: string, mismatch = false) => {
    const args = [script, runId, workItemId];
    await execute(process.execPath, [...args, 'write'], { cwd: root, env: { ...env, EVIDENCE_MISMATCH: mismatch ? '1' : '0' }, timeout: 15_000 });
    const { stdout } = await execute(process.execPath, [...args, 'read'], { cwd: root, env, timeout: 15_000 });
    return JSON.parse(stdout);
  };
  const readCalls = async () => (await readFile(callsPath, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));

  const withoutSelection = await run('evidence-off', 'github:acme/api#42');
  expect(withoutSelection.integrity).toMatchObject({ valid: true, lastSequence: 3 });
  expect(withoutSelection.localBytes).toBeUndefined();
  expect(await readCalls()).toEqual([]);

  await appendFile(join(home, '.afk', 'plugins.yml'), '\nevidenceStore: { provider: primary, scopes: ["github:acme/api"] }\n');
  const outsideScope = await run('evidence-other-project', 'github:acme/other#42');
  expect(outsideScope.integrity).toMatchObject({ valid: true, lastSequence: 3 });
  expect(outsideScope.localBytes).toBeUndefined();
  expect(await readCalls()).toEqual([]);

  for (const mismatch of [false, true]) {
    await writeFile(callsPath, '');
    const { events, integrity, localBytes } = await run(mismatch ? 'evidence-mismatch' : 'evidence-match', 'github:acme/api#42', mismatch);
    const [, , source, receipt] = events;
    expect(integrity).toMatchObject({ valid: true, lastSequence: 4 });
    expect(source).toMatchObject({ data: { kind: 'run.finished', outcome: 'succeeded' }, evidence: [{ uri: expect.stringMatching(/^evidence:\/\/[a-f0-9]{64}$/) }] });
    expect(receipt).toMatchObject({ causationId: source.id, data: { effectKind: 'evidence.mirror', outcome: mismatch ? 'failed' : 'succeeded' } });
    const summary = JSON.parse(receipt.data.summary);
    expect(summary).toMatchObject({ sourceEventId: source.id, localSha256: source.evidence[0].sha256, recordId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(summary.reason).toBe(mismatch ? 'provider_failed' : undefined);
    expect(JSON.parse(Buffer.from(localBytes, 'base64').toString())).toMatchObject({ sourceEventId: source.id, kind: 'run.finished' });
    expect(await readCalls()).toEqual([
      { name: 'primary', operation: 'put', id: summary.recordId, bytes: localBytes },
      { name: 'primary', operation: 'get', id: summary.recordId, bytes: mismatch ? Buffer.from('mismatched-fixture-bytes').toString('base64') : localBytes },
    ]);
  }
});
