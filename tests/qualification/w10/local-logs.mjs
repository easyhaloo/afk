import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const release = resolve(process.argv[2]);
const runtime = join(release, 'node_modules/@afk/runtime/dist');
const root = await mkdtemp(join(tmpdir(), 'installed-local-logs-'));
try {
  const eventsRoot = join(root, 'events');
  const blocked = join(root, 'blocked-log-directory');
  await writeFile(blocked, 'regular file');
  process.env.AFK_LOG_DIR = blocked;
  const { RunObserver } = await import(pathToFileURL(join(runtime, 'observability/run-observer.js')));
  const { JsonlEventStore } = await import(pathToFileURL(join(runtime, 'infrastructure/observability/jsonl-event-store.js')));
  const observer = new RunObserver({ events: new JsonlEventStore({ root: eventsRoot }) });
  for (const runId of ['blocked', 'recovered']) {
    if (runId === 'recovered') process.env.AFK_LOG_DIR = join(root, 'healthy');
    const context = { traceId: runId, runId, workItemId: 'github:fixture/logs#1', profileId: 'local', attempt: 1,
      actor: { kind: 'cli', id: 'qualification' } };
    await observer.record(context, { kind: 'run.requested', run: { id: runId, workItemId: context.workItemId,
      profileId: context.profileId, attempt: context.attempt, status: 'pending' } });
    const output = execFileSync(process.execPath, [join(release, 'dist/index.js'), 'observe', 'timeline', runId, '--root', eventsRoot, '--json'],
      { cwd: root, encoding: 'utf8', env: { ...process.env, AFK_LOG_DIR: join(root, 'reader-logs') } });
    assert.ok(!output.includes(blocked));
    const { integrity, events } = JSON.parse(output);
    assert.equal(integrity.valid, true);
    assert.deepEqual(events.map(event => event.data.kind), runId === 'blocked' ? ['run.requested', 'effect.completed'] : ['run.requested']);
    if (runId === 'blocked') {
      assert.equal(events[1].data.effectKind, 'observability.delivery');
      const summary = JSON.parse(events[1].data.summary);
      assert.equal(summary.dayRotatorWriteFailures, 1);
      assert.equal(summary.counts.logging.failed, 1);
    }
  }
  console.log('Installed timeline verified one log write failure and a healthy subsequent run.');
} finally {
  await rm(root, { recursive: true, force: true });
}
