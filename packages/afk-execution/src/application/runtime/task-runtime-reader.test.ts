import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeRecord } from './runtime-record.js';
import { TaskRuntimeReader, TaskRuntimeStore, type TaskRuntimeRecord } from './task-runtime.js';

const now = Date.parse('2026-10-15T01:00:00.000Z');
const workItemId = 'github:org/repo#42';

async function runtimeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'afk-runtime-reader-'));
  await mkdir(join(root, 'active'), { recursive: true });
  await mkdir(join(root, 'archive'), { recursive: true });
  return root;
}

function write(root: string, bucket: 'active' | 'archive', name: string, value: unknown): Promise<void> {
  return writeFile(join(root, bucket, `${name}.json`), JSON.stringify(value));
}

function record(overrides: Partial<TaskRuntimeRecord> = {}): TaskRuntimeRecord {
  return {
    runId: 'run-42',
    backlogId: '42',
    phase: 'implementing',
    status: 'running',
    sandboxProvider: 'local',
    executionMode: 'batch',
    agentProvider: 'claude-code',
    providerRef: workItemId,
    startedAt: '2026-10-15T00:00:00.000Z',
    heartbeatAt: '2026-10-15T00:00:00.000Z',
    ...overrides,
  };
}

describe('TaskRuntimeReader', () => {
  it('returns the records of both buckets, newest heartbeat first', async () => {
    const root = await runtimeRoot();
    await write(root, 'active', 'active', record({ runId: 'run-active', heartbeatAt: '2026-10-15T00:30:00.000Z' }));
    await write(root, 'archive', 'archived', record({ runId: 'run-archived', status: 'completed', heartbeatAt: '2026-10-15T00:45:00.000Z' }));

    const entries = await new TaskRuntimeReader({ root, now: () => now }).list();

    expect(entries.map(entry => entry.record.runId)).toEqual(['run-archived', 'run-active']);
    expect(entries.map(entry => entry.bucket)).toEqual(['archive', 'active']);
  });

  it('reads a record that predates the environment fields, and leaves them absent', async () => {
    const root = await runtimeRoot();
    await write(root, 'archive', 'legacy', {
      runId: 'legacy-42',
      backlogId: '42',
      phase: 'implementing',
      status: 'completed',
      providerRef: workItemId,
      startedAt: '2026-10-15T00:00:00.000Z',
      heartbeatAt: '2026-10-15T00:05:00.000Z',
    });

    const entries = await new TaskRuntimeReader({ root, now: () => now }).list();

    expect(entries).toHaveLength(1);
    expect(entries[0]?.record.runId).toBe('legacy-42');
    // History that does not know the environment says so: no value is invented.
    expect(entries[0]?.record.sandboxProvider).toBeUndefined();
    expect(entries[0]?.record.executionMode).toBeUndefined();
    expect(entries[0]?.record.agentProvider).toBeUndefined();
  });

  it('keeps a legacy record in the store view too', async () => {
    const root = await runtimeRoot();
    await write(root, 'active', 'legacy', {
      runId: 'legacy-42',
      backlogId: '42',
      phase: 'implementing',
      status: 'running',
      startedAt: '2026-10-15T00:00:00.000Z',
      heartbeatAt: '2026-10-15T00:05:00.000Z',
    });

    const active = await new TaskRuntimeStore(root).listActive();

    expect(active.map(item => item.runId)).toEqual(['legacy-42']);
  });

  it('rejects a record that is malformed in a way that matters', async () => {
    const root = await runtimeRoot();
    await write(root, 'active', 'no-run-id', {
      backlogId: '42', phase: 'implementing', status: 'running',
      startedAt: '2026-10-15T00:00:00.000Z', heartbeatAt: '2026-10-15T00:05:00.000Z',
    });
    await write(root, 'active', 'no-heartbeat', {
      runId: 'run-no-heartbeat', backlogId: '42', phase: 'implementing', status: 'running',
      startedAt: '2026-10-15T00:00:00.000Z',
    });
    await write(root, 'active', 'bad-started-at', {
      runId: 'run-bad-started', backlogId: '42', phase: 'implementing', status: 'running',
      startedAt: 'not-a-date', heartbeatAt: '2026-10-15T00:05:00.000Z',
    });

    await expect(new TaskRuntimeReader({ root, now: () => now }).list()).resolves.toEqual([]);
  });

  it('filters the records by the shared identity rule', async () => {
    const root = await runtimeRoot();
    await write(root, 'active', 'mine', record({ runId: 'run-mine' }));
    await write(root, 'active', 'theirs', record({ runId: 'run-theirs', providerRef: 'github:other/repo#42' }));

    const entries = await new TaskRuntimeReader({ root, now: () => now }).list({ identity: { workItemId } });

    expect(entries.map(entry => entry.record.runId)).toEqual(['run-mine']);
  });

  it('judges staleness with the shared rule, for the active records only', async () => {
    const root = await runtimeRoot();
    await write(root, 'active', 'cold', record({ runId: 'run-cold', heartbeatAt: '2026-10-15T00:00:00.000Z' }));
    await write(root, 'active', 'warm', record({ runId: 'run-warm', heartbeatAt: '2026-10-15T00:59:00.000Z' }));
    await write(root, 'archive', 'done', record({ runId: 'run-done', status: 'completed', heartbeatAt: '2026-10-14T00:00:00.000Z' }));

    const entries = await new TaskRuntimeReader({ root, now: () => now }).list();

    expect(entries.find(entry => entry.record.runId === 'run-cold')?.status).toBe('stale');
    expect(entries.find(entry => entry.record.runId === 'run-warm')?.status).toBe('running');
    expect(entries.find(entry => entry.record.runId === 'run-done')?.status).toBe('completed');
  });

  it('finds one run, and prefers the active record over the archived one', async () => {
    const root = await runtimeRoot();
    const key = Buffer.from('run-42', 'utf8').toString('base64url');
    await write(root, 'archive', key, record({ runId: 'run-42', status: 'completed' }));
    await write(root, 'active', key, record({ runId: 'run-42', heartbeatAt: '2026-10-15T00:59:00.000Z' }));

    const reader = new TaskRuntimeReader({ root, now: () => now });
    const entry = await reader.find('run-42', { workItemId });

    expect(entry?.bucket).toBe('active');
    expect(entry?.status).toBe('running');
  });

  it('does not hand a record of another work item to the caller', async () => {
    const root = await runtimeRoot();
    const key = Buffer.from('run-42', 'utf8').toString('base64url');
    await write(root, 'active', key, record({ runId: 'run-42', providerRef: 'github:other/repo#42' }));

    const reader = new TaskRuntimeReader({ root, now: () => now });

    await expect(reader.find('run-42', { workItemId })).resolves.toBeUndefined();
  });

  it('reads a record published today back complete', async () => {
    const root = await runtimeRoot();
    await new TaskRuntimeStore(root).start(runtimeRecord({
      runId: 'run-42', backlogId: '42', phase: 'implementing', progress: 'claimed',
      sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
      providerRef: workItemId, now: '2026-10-15T00:59:00.000Z',
    }));

    const entries = await new TaskRuntimeReader({ root, now: () => now }).list();

    expect(entries[0]?.record).toMatchObject({
      sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
    });
  });
});
