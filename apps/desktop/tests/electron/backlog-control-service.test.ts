import { describe, expect, it, vi } from 'vitest';
import { createBacklogControlService } from '../../electron/services/backlog-control-service.js';
import type { BacklogRuntimeSummary } from '../../shared/backlog-contract.js';

function fixture() {
  const current: BacklogRuntimeSummary = {
    backlogId: '42',
    backlog: { id: '42', title: 'task', state: 'in_progress', executionMode: 'afk', dependsOn: [], tags: [], branchName: 'afk/42', providerRef: 'github:acme/api#42' },
    activeRun: { id: 'worker-42', backlogId: '42', status: 'running', pid: 1234, startedAt: '2026-10-21T01:00:00Z' },
  };
  let alive = true;
  const deps = {
    summary: vi.fn(async () => current),
    interrupt: vi.fn(async () => { current.backlog.state = 'blocked'; current.backlog.executionMode = 'hitl'; }),
    confirmMerge: vi.fn(async () => { current.backlog.state = 'done'; }),
    recordStopped: vi.fn(async () => undefined),
    isPidAlive: vi.fn(() => alive),
    kill: vi.fn(() => { alive = false; }),
  };
  return { current, deps, service: createBacklogControlService(deps) };
}

describe('backlog runtime controls', () => {
  it('stops the current Worker, records its receipt and interrupts through Runtime', async () => {
    const { deps, service } = fixture();
    expect((await service.stop('/repo', '42')).backlog).toMatchObject({ state: 'blocked', executionMode: 'hitl' });
    expect(deps.kill).toHaveBeenCalledWith(1234, 'SIGTERM');
    expect(deps.recordStopped).toHaveBeenCalledWith('/repo', '42', 'worker-42');
    expect(deps.interrupt).toHaveBeenCalledWith('/repo', '42', '用户从桌面停止执行');
  });

  it('refuses to change provider state when the Worker cannot be stopped', async () => {
    const { deps } = fixture();
    deps.kill.mockImplementation(() => undefined);
    const service = createBacklogControlService({ ...deps, stopTimeoutMs: 0 });
    await expect(service.stop('/repo', '42')).rejects.toThrow('仍在运行');
    expect(deps.kill.mock.calls).toEqual([[1234, 'SIGTERM'], [1234, 'SIGKILL']]);
    expect(deps.recordStopped).not.toHaveBeenCalled();
    expect(deps.interrupt).not.toHaveBeenCalled();
  });

  it('does not recover a stale heartbeat while the Worker is still alive', async () => {
    const { current, deps, service } = fixture();
    current.runtime = { runId: 'runtime-42', status: 'stale', phase: 'implementing', heartbeatAt: '2026-10-21T01:00:00Z' };
    await expect(service.recover('/repo', '42')).rejects.toThrow('仍在运行');
    expect(deps.interrupt).not.toHaveBeenCalled();
  });

  it('rechecks stale status before recovery', async () => {
    const { current, deps, service } = fixture();
    deps.isPidAlive.mockReturnValue(false);
    current.runtime = { runId: 'runtime-42', status: 'running', phase: 'implementing', heartbeatAt: '2026-10-21T01:00:00Z' };
    deps.summary.mockResolvedValueOnce({ ...current, runtime: { ...current.runtime, status: 'stale' } });
    await expect(service.recover('/repo', '42')).rejects.toThrow('已恢复');
    expect(deps.interrupt).not.toHaveBeenCalled();
  });

  it('confirms merging through Runtime and returns the refreshed summary', async () => {
    const { deps, service } = fixture();
    expect((await service.confirmMerge('/repo', '42')).backlog.state).toBe('done');
    expect(deps.confirmMerge).toHaveBeenCalledWith('/repo', '42');
  });
});
