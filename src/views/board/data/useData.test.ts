import { describe, expect, it, vi } from 'vitest';
import type { BacklogItem } from '../../../lib/core/backlog';
import { loadDashboardBacklogs, toRuntimeTask } from './useData';

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
