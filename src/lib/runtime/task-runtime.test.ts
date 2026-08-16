import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TaskRuntimeManager, TaskRuntimeStore, type TaskRuntimeRecord } from './task-runtime';

async function storeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'afk-runtime-'));
  return new TaskRuntimeStore(root);
}

function record(overrides: Partial<TaskRuntimeRecord> = {}): TaskRuntimeRecord {
  const now = new Date().toISOString();
  return {
    runId: 'run-42',
    backlogId: '42',
    title: 'Add search',
    phase: 'implementing',
    status: 'running',
    sandboxProvider: 'local',
    executionMode: 'batch',
    agentProvider: 'claude-code',
    session: 'afk-42',
    worktree: '/tmp/afk-42',
    branch: 'afk/backlog-42',
    startedAt: now,
    heartbeatAt: now,
    ...overrides,
  };
}

describe('TaskRuntimeStore', () => {
  it('preserves the task while filtering malformed persisted activities', async () => {
    const store = await storeFixture();
    await store.start(record());
    const [filename] = await readdir(store.activePath);
    const path = join(store.activePath, filename!);
    const persisted = JSON.parse(await readFile(path, 'utf8'));
    persisted.activities = [
      persisted.activities[0],
      { id: '', taskRunId: 'run-42', at: 'not-a-date', kind: 'tool', message: '' },
    ];
    await writeFile(path, JSON.stringify(persisted));

    const active = await store.listActive();

    expect(active).toHaveLength(1);
    expect(active[0]?.activities).toHaveLength(1);
    expect(active[0]?.activities?.[0]?.message).toBe('runtime started');
  });

  it('serializes concurrent activity appends without losing events', async () => {
    const store = await storeFixture();
    const manager = new TaskRuntimeManager(store);
    await manager.start(record());

    await Promise.all(Array.from({ length: 20 }, (_, index) => manager.appendActivity('run-42', {
      kind: 'tool', message: `concurrent-${index}`,
    })));

    const active = await store.getActive('run-42');
    const appended = active?.activities?.filter(item => item.kind === 'tool') ?? [];
    expect(appended).toHaveLength(20);
    expect(new Set(appended.map(item => item.id)).size).toBe(20);
  });

  it('creates distinct activity IDs for long externally-derived run IDs', async () => {
    const runId = `session-${'x'.repeat(80)}`;
    const store = await storeFixture();
    const manager = new TaskRuntimeManager(store);
    await manager.start(record({ runId }));

    await manager.appendActivity(runId, { at: '2026-08-09T10:00:00.000Z', kind: 'tool', message: 'first' });
    await manager.appendActivity(runId, { at: '2026-08-09T10:00:01.000Z', kind: 'tool', message: 'second' });

    const ids = (await store.getActive(runId))?.activities?.map(item => item.id) ?? [];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keeps only the newest bounded runtime activities in chronological order', async () => {
    const store = await storeFixture();
    const manager = new TaskRuntimeManager(store);
    await manager.start(record());

    for (let index = 0; index < 55; index += 1) {
      await manager.appendActivity('run-42', {
        at: new Date(Date.now() + index).toISOString(),
        kind: 'tool',
        message: `tool-${index}`,
      });
    }

    const active = await store.getActive('run-42');
    expect(active?.activities).toHaveLength(50);
    expect(active?.activities?.[0]?.message).toBe('tool-5');
    expect(active?.activities?.at(-1)?.message).toBe('tool-54');
    expect(active?.activities?.map(item => item.at)).toEqual(
      [...(active?.activities ?? [])].sort((left, right) => left.at.localeCompare(right.at)).map(item => item.at),
    );
  });

  it('atomically persists active records and updates their heartbeat', async () => {
    const store = await storeFixture();
    const initial = record();
    await store.start(initial);

    const updated = await store.update(initial.runId, { phase: 'verifying', progress: 'qa queued' });
    expect(updated.phase).toBe('verifying');
    expect(updated.heartbeatAt).not.toBe(initial.heartbeatAt);

    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ runId: 'run-42', phase: 'verifying', progress: 'qa queued' });
    const [activeFilename] = await readdir(store.activePath);
    expect(JSON.parse(await readFile(join(store.activePath, activeFilename!), 'utf8'))).toMatchObject({ status: 'running' });
    await expect(readFile(join(store.diagnosticPathFor('run-42'), 'runtime.json'), 'utf8')).resolves.toContain('"backlogId": "42"');
  });

  it('persists only redacted transport-neutral agent diagnostics', async () => {
    const store = await storeFixture();
    await store.start(record({
      agentProvider: 'codex',
      agentTransport: 'app-server',
      agentAuth: 'chatgpt',
      agentModelProvider: 'openai',
      agentThreadId: 'thread-42',
    }));

    await expect(store.getActive('run-42')).resolves.toMatchObject({
      agentProvider: 'codex',
      agentTransport: 'app-server',
      agentAuth: 'chatgpt',
      agentModelProvider: 'openai',
      agentThreadId: 'thread-42',
    });
  });

  it('archives terminal records and keeps the final diagnostic summary', async () => {
    const store = await storeFixture();
    await store.start(record());

    const archived = await store.finish('run-42', { status: 'blocked', errorSummary: 'agent launch rejected', diagnosticPath: '/tmp/run.log' });
    expect(archived.status).toBe('blocked');
    expect(archived.errorSummary).toBe('agent launch rejected');
    expect(await store.listActive()).toEqual([]);
    expect(await store.listArchive()).toEqual([expect.objectContaining({ runId: 'run-42', diagnosticPath: '/tmp/run.log' })]);
  });

  it('keeps execution output and result beside the active runtime record', async () => {
    const store = await storeFixture();
    await store.start(record());

    const diagnosticPath = await store.writeDiagnostics('run-42', {
      result: { status: 'failed', exitCode: 1 },
      output: 'agent stderr tail',
    });

    expect(diagnosticPath).toBe(store.diagnosticPathFor('run-42'));
    expect(await readFile(join(diagnosticPath, 'result.json'), 'utf8')).toContain('"exitCode": 1');
    await expect(readFile(join(diagnosticPath, 'output.log'), 'utf8')).resolves.toBe('agent stderr tail');
    const active = await store.getActive('run-42');
    expect(active).toMatchObject({ diagnosticPath });
    expect(active?.activities?.some(activity => activity.message === 'diagnostics captured')).toBe(false);
  });

  it('keeps externally-derived run IDs inside the runtime root', async () => {
    const store = await storeFixture();
    const malicious = record({ runId: '../../outside/../../session' });
    await store.start(malicious);

    expect(await readdir(store.activePath)).toHaveLength(1);
    expect(store.diagnosticPathFor(malicious.runId).startsWith(store.diagnosticsPath)).toBe(true);
    await expect(store.getActive(malicious.runId)).resolves.toMatchObject({ runId: malicious.runId });
  });
});

describe('TaskRuntimeManager', () => {
  it('marks an old heartbeat as stale without dropping the runtime record', async () => {
    const store = await storeFixture();
    const manager = new TaskRuntimeManager(store, { staleAfterMs: 1_000 });
    const old = new Date(Date.now() - 5_000).toISOString();
    await manager.start(record({ heartbeatAt: old, startedAt: old }));

    await expect(manager.listActive()).resolves.toEqual([
      expect.objectContaining({ runId: 'run-42', status: 'stale' }),
    ]);
  });
});
