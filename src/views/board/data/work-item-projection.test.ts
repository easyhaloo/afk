import { describe, expect, it } from 'vitest';
import type { BacklogItem } from '../../../domain/backlog';
import type { TaskRuntimeRecord } from '../../../application/runtime/task-runtime';
import { projectWorkItems } from './work-item-projection';

const backlog = (overrides: Partial<BacklogItem> = {}): BacklogItem => ({
  id: '42',
  title: 'Fix API',
  dependsOn: [],
  state: 'blocked',
  executionMode: 'afk',
  tags: [],
  branchName: 'afk/backlog-42',
  providerRef: 'github:org/repo#42',
  ...overrides,
});

const runtime = (overrides: Partial<TaskRuntimeRecord> = {}): TaskRuntimeRecord => ({
  runId: 'run-42-old',
  backlogId: '42',
  title: 'runtime title',
  phase: 'implementing',
  status: 'running',
  sandboxProvider: 'local',
  executionMode: 'batch',
  agentProvider: 'claude-code',
  workspace: '/workspace/org-repo',
  providerRef: 'github:org/repo#42',
  startedAt: '2026-08-09T10:00:00.000Z',
  heartbeatAt: '2026-08-09T10:01:00.000Z',
  ...overrides,
});

describe('work-item projection', () => {
  it('joins active and archived runtime records by exact string backlogId', () => {
    const result = projectWorkItems({
      now: Date.parse('2026-08-09T10:02:30.000Z'),
      backlogs: [backlog({ id: '42' })],
      active: [runtime({ runId: 'run-42', heartbeatAt: '2026-08-09T10:02:00.000Z' })],
      archive: [runtime({ runId: 'run-42-old', backlogId: '42', status: 'completed' })],
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      backlogId: '42',
      backlogState: 'blocked',
      runId: 'run-42',
      runStatus: 'running',
      phase: 'implementing',
    });
  });

  it('marks an old active heartbeat stale without changing backlogState', () => {
    const result = projectWorkItems({
      now: Date.parse('2026-08-09T10:10:00.000Z'),
      staleAfterMs: 60_000,
      backlogs: [backlog({ state: 'in_progress' })],
      active: [runtime({ heartbeatAt: '2026-08-09T10:00:00.000Z' })],
      archive: [],
    });

    expect(result[0]).toMatchObject({ backlogState: 'in_progress', runStatus: 'stale', phase: 'implementing' });
  });

  it('selects the run with the newest heartbeat for one backlog', () => {
    const result = projectWorkItems({
      backlogs: [backlog()],
      active: [runtime({ runId: 'run-old', heartbeatAt: '2026-08-09T10:01:00.000Z' })],
      archive: [runtime({ runId: 'run-new', status: 'failed', phase: 'verifying', heartbeatAt: '2026-08-09T10:03:00.000Z' })],
    });

    expect(result[0]).toMatchObject({ runId: 'run-new', runStatus: 'failed', phase: 'verifying' });
  });

  it('keeps a backlog with no runtime and an orphan runtime visible', () => {
    const result = projectWorkItems({
      backlogs: [backlog({ id: 'blocked-only' })],
      active: [runtime({ backlogId: 'runtime-only', runId: 'orphan-run' })],
      archive: [],
    });

    expect(result).toEqual([
      expect.objectContaining({ backlogId: 'blocked-only', backlogState: 'blocked', runStatus: undefined, phase: undefined }),
      expect.objectContaining({ backlogId: 'runtime-only', backlogState: undefined, runId: 'orphan-run' }),
    ]);
  });

  it('does not join a matching numeric backlogId from another workspace or provider', () => {
    const result = projectWorkItems({
      workspace: '/workspace/org-repo',
      backlogs: [backlog()],
      active: [runtime({ workspace: '/workspace/other-repo', providerRef: 'github:other/repo#42' })],
      archive: [],
    });

    expect(result).toEqual([
      expect.objectContaining({ backlogId: '42', backlogState: 'blocked', runId: undefined, runtime: undefined }),
    ]);
  });
});
