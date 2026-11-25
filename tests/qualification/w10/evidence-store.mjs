import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function qualify(sdk, cli, scratch, expectedVersion) {
  const run = (...args) => execFileSync(cli, args, { cwd: scratch, encoding: 'utf8', timeout: 15000 }).trim();
  const version = run('--version');
  assert.equal(version, expectedVersion);
  const { HOME: homeDir, W10_DB: dbPath } = process.env;
  const project = 'github:w10/parcel';
  const events = join(scratch, 'events');
  run('plugin', 'install', fileURLToPath(new URL('./evidence-store/', import.meta.url)));
  const config = sdk.readPluginConfiguration(homeDir);
  config.evidenceStore = { provider: 'sqlite', scopes: [project] };
  writeFileSync(join(homeDir, '.afk/plugins.yml'), JSON.stringify(config));
  const sqliteVersion = execFileSync('sqlite3', [dbPath, `
    CREATE TABLE records(id TEXT PRIMARY KEY, mediaType TEXT, classification TEXT, bytes BLOB NOT NULL);
    CREATE TABLE calls(operation TEXT, id TEXT, receivedBytes INTEGER);
    SELECT sqlite_version();`], { encoding: 'utf8' }).trim();
  const runtime = await sdk.createDefaultPluginRuntime({ homeDir, workspaceRoot: scratch });
  const reader = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const observer = sdk.createPluginRunObserver(runtime, events);
    const record = async (runId, workItemId) => {
      const context = { runId, workItemId, traceId: runId, profileId: 'test', attempt: 1, actor: { kind: 'cli', id: 'w10' } };
      await observer.record(context, { kind: 'run.requested', run: { id: runId, workItemId, profileId: 'test', attempt: 1, status: 'pending' } });
      await observer.record(context, { kind: 'run.started' });
      await observer.record(context, { kind: 'qa.passed' });
      const timeline = JSON.parse(run('observe', 'timeline', runId, '--root', events, '--json'));
      assert.equal(timeline.integrity.valid, true);
      assert.deepEqual(timeline.events.slice(0, 3).map(event => event.data.kind), ['run.requested', 'run.started', 'qa.passed']);
      assert.equal(timeline.events[2].context.workItemId, workItemId);
      return timeline.events;
    };
    const [, , source, effect, ...extra] = await record('w10-allowed', `${project}#1`);
    assert.equal(extra.length, 0);
    assert.equal(effect.data.effectKind, 'evidence.mirror');
    assert.equal(effect.data.outcome, 'succeeded');
    const summary = JSON.parse(effect.data.summary);
    const [ref] = source.evidence;
    const local = await (await sdk.createLocalEncryptedEvidenceStore(homeDir)).get(ref);
    const snapshot = () => ({ records: reader.prepare('SELECT * FROM records ORDER BY id').all(),
      calls: reader.prepare('SELECT * FROM calls ORDER BY rowid').all() });
    const before = snapshot();
    assert.equal(before.records.length, 1);
    const [row] = before.records;
    const digest = hash(row.bytes);
    assert.equal(digest, summary.sha256);
    assert.equal(hash(local), summary.localSha256);
    assert.equal(ref.sha256, summary.localSha256);
    assert.deepEqual(Buffer.from(row.bytes), Buffer.from(local));
    assert.equal(row.id, hash(JSON.stringify([project, source.context.workItemId, source.context.runId, source.id, ref.sha256, digest])));
    assert.equal(row.id, summary.recordId);
    assert.equal(row.mediaType, 'application/json');
    assert.equal(row.classification, 'internal');
    const payload = JSON.parse(Buffer.from(row.bytes));
    assert.equal(payload.sourceEventId, source.id);
    assert.equal(payload.kind, source.data.kind);
    assert.equal(payload.occurredAt, source.occurredAt);
    assert.deepEqual(before.calls.map(call => [call.operation, call.id, call.receivedBytes]),
      [['put', row.id, row.bytes.length], ['get', row.id, 0]]);
    const denied = await record('w10-denied', 'github:w10/parcel-other#1');
    assert.equal(denied.length, 3);
    assert.equal(denied[2].evidence?.length ?? 0, 0);
    assert.deepEqual(snapshot(), before);
    const receipt = { version, cli, cliSha256: hash(readFileSync(cli)), sqliteVersion, node: process.version,
      project, runId: source.context.runId, sourceEventId: source.id, recordId: row.id,
      backendBytes: row.bytes.length, backendSha256: digest, localSha256: ref.sha256, mirror: effect.data.outcome,
      calls: before.calls, negative: { workItemId: denied[0].context.workItemId, auditEvents: denied.length, calls: 0, bytes: 0 } };
    const path = join(scratch, 'receipt.json');
    writeFileSync(path, JSON.stringify(receipt, null, 2) + '\n');
    console.log(path);
  } finally {
    reader.close();
    await runtime.dispose();
  }
}
