import { mkdtemp, readFile, readdir } from 'node:fs/promises';
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
    await expect(store.getActive('run-42')).resolves.toMatchObject({ diagnosticPath });
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
