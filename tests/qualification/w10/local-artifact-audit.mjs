import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const cli = await realpath(process.argv[2]);
const runtime = join(dirname(dirname(cli)), 'node_modules/@afk/runtime/dist');
const sdk = await import(pathToFileURL(join(runtime, 'plugin-sdk/index.js')));
const { LifecycleDispatcher } = await import(pathToFileURL(join(runtime, 'application/workflows/lifecycle.js')));
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'installed-audit-artifacts-')));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function qualify(provider) {
  const workspace = join(scratch, provider);
  const homeDir = join(workspace, 'home');
  const output = join(workspace, 'out');
  const events = join(workspace, 'events');
  await mkdir(join(homeDir, '.afk'), { recursive: true });
  const env = { ...process.env, HOME: homeDir, AFK_LOG_DIR: join(workspace, 'logs'), GIT_CONFIG_NOSYSTEM: '1' };
  const command = (exe, args) => execFileSync(exe, args, { cwd: workspace, env, encoding: 'utf8' }).trim();
  command('git', ['init', '-q', '-b', 'main']);
  command('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'qualification', '--allow-empty']);
  const head = command('git', ['rev-parse', 'HEAD']);
  const check = [process.execPath, '-e', 'process.exit(0)'];
  await writeFile(join(homeDir, '.afk/plugins.yml'), JSON.stringify({
    plugins: [{ id: `artifact.${provider}`, builtin: true, config: { root: output } }],
    integrations: { evidence: { provider }, verifications: [{ provider: 'test-runner', command: check }] },
  }));
  const plugins = await sdk.createDefaultPluginRuntime({ homeDir, workspaceRoot: workspace });
  try {
    const lifecycle = new LifecycleDispatcher(plugins.getLifecycleModules());
    await lifecycle.run('init', { iid: 1, baseBranch: 'main', params: {}, originalCwd: workspace });
    const identity = { traceId: provider, runId: provider, workItemId: 'github:qualification/artifacts#1', profileId: 'local', attempt: 1, actor: { kind: 'cli', id: 'qualification' } };
    const observer = sdk.createPluginRunObserver(plugins, events);
    await observer.record(identity, { kind: 'run.requested', run: { id: provider, workItemId: identity.workItemId, profileId: 'local', attempt: 1, status: 'pending' } });
    await observer.record(identity, { kind: 'run.started' });
    await lifecycle.run('after-agent', { iid: 1, worktreePath: workspace, baseBranch: 'main', sessionName: provider, params: {},
      observation: { context: identity, record: (data, options) => observer.record(identity, data, options) } });
    const timeline = JSON.parse(command(cli, ['observe', 'timeline', provider, '--root', events, '--json']));
    assert.equal(timeline.integrity.valid, true);
    const source = timeline.events.find(event => event.data.effectKind === 'verification' && event.data.outcome === 'succeeded');
    const uploads = timeline.events.filter(event => event.causationId === source.id && event.data.effectKind === 'artifact.upload');
    assert.equal(uploads.length, 1);
    const [upload] = uploads;
    assert.equal(upload.data.outcome, 'succeeded');
    const summary = JSON.parse(upload.data.summary);
    assert.equal(summary.sourceEventId, source.id);
    const [localRef] = source.evidence;
    const [exportRef] = upload.evidence;
    const localBytes = Buffer.from(await (await sdk.createLocalEncryptedEvidenceStore(homeDir)).get(localRef));
    assert.equal(hash(localBytes), localRef.sha256);
    assert.equal(localRef.sha256, summary.localSha256);
    const receipt = JSON.parse(localBytes);
    assert.equal(receipt.protocol, 'capability-verification-v1');
    assert.equal(receipt.executionId, source.idempotencyKey);
    assert.equal(receipt.revision.after.head, head);
    assert.deepEqual(receipt.result.execution.command, check);
    assert.equal(receipt.result.execution.exitCode, 0);
    assert.equal(receipt.observation.runId, provider);
    const path = fileURLToPath(exportRef.uri);
    assert.equal(dirname(path), output);
    const exported = await readFile(path);
    if (provider === 'evidence-bundle') {
      const bundle = JSON.parse(exported);
      assert.equal(bundle.records.length, 1);
      assert.equal(bundle.records[0].sha256, localRef.sha256);
      assert.equal(bundle.records[0].size, localBytes.length);
      assert.equal(bundle.bundleSha256, hash(JSON.stringify(bundle.records)));
    } else {
      assert.deepEqual(exported, localBytes);
    }
    console.log(JSON.stringify({ provider, version: command(cli, ['--version']), sourceEventId: source.id,
      sourceSha256: localRef.sha256, receiptSha256: exportRef.sha256, fileSha256: hash(exported), size: exported.length }));
    assert.equal(exportRef.sha256, hash(exported), 'export evidence reference must identify the bytes at its URI');
    assert.equal(exportRef.mediaType, 'application/json');
  } finally { await plugins.dispose(); }
}

try {
  for (const provider of ['test-report-local', 'evidence-bundle']) await qualify(provider);
} finally { await rm(scratch, { recursive: true, force: true }); }
