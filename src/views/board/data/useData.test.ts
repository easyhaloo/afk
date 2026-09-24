import React from 'react';
import { Text, render } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../../domain/backlog';
import { loadDashboardBacklogs, loadDashboardTasks, projectBacklogRuntime, toRuntimeTask } from './useData';
import { useData } from './useData';
import { fetchTasks } from './fetcher';

vi.mock('./fetcher', async importOriginal => {
  const actual = await importOriginal<typeof import('./fetcher')>();
  return { ...actual, fetchTasks: vi.fn() };
});

const backlog: BacklogItem = {
  id: '42',
  title: 'Fix API',
  dependsOn: [],
  state: 'ready',
  executionMode: 'afk',
  tags: [],
  branchName: 'afk/backlog-42',
  providerRef: 'github:org/repo#42',
};

describe('dashboard backlog data flow', () => {
  it('loads backlog records through the injected read-only management provider', async () => {
    const list = vi.fn(async () => [backlog]);
    const claim = vi.fn();
    const bundle = {
      backlog: {
        get: vi.fn(),
        list,
        initialize: vi.fn(),
        claim,
      },
    };

    await expect(loadDashboardBacklogs(bundle)).resolves.toEqual([
      expect.objectContaining({ id: '42', state: 'ready', executionMode: 'afk' }),
    ]);
    expect(list).toHaveBeenCalledWith(undefined);
    expect(claim).not.toHaveBeenCalled();
  });
});

describe('dashboard task runtime data flow', () => {
  it('runs the real useData refresh chain through fetchTasks and backlog reprojection', async () => {
    const fetchTasksMock = vi.mocked(fetchTasks);
    const heartbeatAt = new Date().toISOString();
    fetchTasksMock.mockImplementation(async (_manager, backlogs = []) => ({
      active: backlogs.length > 0 ? [{
        backlogId: backlogs[0]!.id,
        iid: backlogs[0]!.id,
        runId: 'run-42',
        title: backlogs[0]!.title,
        phase: 'verifying',
        executionMode: 'batch',
        sandboxProvider: 'local',
        agentProvider: 'claude-code',
        status: 'active',
        runStatus: 'running',
        progress: '75%',
        startedAt: new Date(heartbeatAt),
        heartbeatAt: new Date(heartbeatAt),
      }] : [],
      completed: [],
    }));
    const list = vi.fn(async () => [backlog]);
    const management = { backlog: { list } } as never;
    let latest: ReturnType<typeof useData> | undefined;
    function Probe() {
      latest = useData('backlogs', management);
      return React.createElement(Text, null, latest.backlogs.map(item => `${item.id}:${item.runStatus ?? 'no-runtime'}:${item.phase ?? '-'}`).join('|'));
    }

    const app = render(React.createElement(Probe));
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fetchTasksMock).toHaveBeenLastCalledWith(undefined, [expect.objectContaining({ id: '42' })]);
      expect(latest?.backlogs[0]).toMatchObject({ id: '42', runStatus: 'running', phase: 'verifying', progress: '75%' });

      await latest!.refreshBacklogs();
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(fetchTasksMock).toHaveBeenLastCalledWith(undefined, [expect.objectContaining({ id: '42' })]);
      expect(latest?.backlogs[0]).toMatchObject({ id: '42', runStatus: 'running', phase: 'verifying', progress: '75%' });
    } finally {
      app.unmount();
    }
  });

  it('passes loaded backlogs into the runtime projection', async () => {
    const heartbeatAt = new Date().toISOString();
    const manager = {
      listActive: vi.fn(async () => [{
        runId: 'run-42', backlogId: '42', title: 'runtime title', phase: 'implementing', status: 'running',
        sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
        startedAt: heartbeatAt, heartbeatAt,
      }]),
      listArchive: vi.fn(async () => []),
    };

    const result = await loadDashboardTasks([backlog], manager as never);

    expect(result.active[0]).toMatchObject({ backlogId: '42', title: 'Fix API', runStatus: 'running' });
    expect(fetchTasks).toHaveBeenCalledWith(manager, [backlog]);
  });

  it('reprojects refreshed backlogs without dropping a backlog that has no runtime', () => {
    const tasks = [toRuntimeTask({
      runId: 'run-42', backlogId: '42', title: 'old title', phase: 'verifying', status: 'running',
      sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
      startedAt: '2026-08-05T00:00:00.000Z', heartbeatAt: '2026-08-05T00:01:00.000Z', progress: '50%',
    })];

    expect(projectBacklogRuntime([
      { ...backlog, state: 'blocked' },
      { ...backlog, id: '43', title: 'No runtime' },
    ], tasks)).toEqual([
      expect.objectContaining({ id: '42', state: 'blocked', runStatus: 'running', phase: 'verifying', progress: '50%' }),
      expect.objectContaining({ id: '43', state: 'ready', runStatus: undefined, phase: undefined, progress: undefined }),
    ]);
  });

  it('does not join a backlog through the legacy iid or runId aliases', () => {
    const task = toRuntimeTask({
      runId: '42', backlogId: 'different-backlog', title: 'runtime title', phase: 'implementing', status: 'running',
      sandboxProvider: 'local', executionMode: 'batch', agentProvider: 'claude-code',
      startedAt: '2026-08-05T00:00:00.000Z', heartbeatAt: '2026-08-05T00:01:00.000Z', progress: '50%',
    });
    const legacyOnlyTask = { ...task, backlogId: undefined, iid: '42', runId: '42' };

    expect(projectBacklogRuntime([backlog], [legacyOnlyTask])).toEqual([
      expect.objectContaining({ id: '42', runStatus: undefined, phase: undefined, progress: undefined }),
    ]);
  });

  it('maps a filesystem runtime record without using backlog or tmux state', () => {
    expect(toRuntimeTask({
      runId: 'afk-42-1',
      backlogId: '42',
      title: 'Fix API',
      phase: 'verifying',
      status: 'running',
      sandboxProvider: 'local',
      executionMode: 'batch',
      agentProvider: 'claude-code',
      worktree: '/tmp/afk-42',
      branch: 'afk/backlog-42',
      startedAt: '2026-08-05T00:00:00.000Z',
      heartbeatAt: '2026-08-05T00:01:00.000Z',
      diagnosticPath: '/tmp/afk-42/.afk/runs/one',
    })).toMatchObject({
      iid: '42', status: 'active', phase: 'verifying', executionMode: 'batch',
      agentProvider: 'claude-code', diagnosticPath: '/tmp/afk-42/.afk/runs/one',
    });
  });
});
