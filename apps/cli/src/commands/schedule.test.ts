import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({ scheduleWorkItems: vi.fn(), detail: vi.fn(), dispose: vi.fn(), registry: {} }));
vi.mock('@afk/runtime/plugin-sdk', () => ({
  createDefaultPluginRuntime: vi.fn(async () => ({ getAgentProviderRegistry: () => mocks.registry, dispose: mocks.dispose })),
}));
vi.mock('@afk/runtime/execution', async importOriginal => ({
  ...(await importOriginal<typeof import('@afk/runtime/execution')>()),
  scheduleWorkItems: mocks.scheduleWorkItems,
}));
vi.mock('../output.js', () => ({
  handleCommandError: (error: unknown) => { expect(mocks.dispose).toHaveBeenCalledOnce(); throw error; }, success: vi.fn(), warning: vi.fn(), detail: mocks.detail,
}));

import { registerScheduleCommands } from './schedule.js';

async function invoke(argv: string[]) {
  const program = new Command().name('afk').exitOverride();
  registerScheduleCommands(program);
  await program.parseAsync(['node', 'afk', 'schedule', ...argv]);
}

describe('schedule CLI', () => {
  afterEach(() => { vi.clearAllMocks(); process.exitCode = 0; });

  it('prints why every waiting item is waiting', async () => {
    mocks.scheduleWorkItems.mockResolvedValue({
      parent: 'github:acme/prd#1', capacity: 4, executions: [], stopped: false,
      waiting: [
        { workItemId: 'github:acme/api#2', runnability: { runnable: true, blockedBy: [] }, waitReason: 'capacity_full' },
        { workItemId: 'github:acme/web#3', runnability: { runnable: false, reason: 'dependency_not_done', blockedBy: ['github:acme/base#9'] }, waitReason: 'dependency_not_ready' },
        { workItemId: 'github:acme/docs#4', runnability: { runnable: false, reason: 'awaiting_merge', blockedBy: [] }, waitReason: 'awaiting_human' },
      ],
    });
    await invoke(['--parent', 'github:acme/prd#1']);
    const printed = mocks.detail.mock.calls.map(call => String(call[0]));
    expect(printed).toContain('github:acme/api#2: waiting for a free execution slot');
    expect(printed).toContain('github:acme/web#3: waiting for a dependency to finish');
    expect(printed).toContain('github:acme/docs#4: waiting for a person');
  });

  it('falls back to the runnability reason for a report written before wait reasons existed', async () => {
    mocks.scheduleWorkItems.mockResolvedValue({
      parent: 'github:acme/prd#1', capacity: 4, executions: [], stopped: false,
      waiting: [{ workItemId: 'github:acme/api#2', runnability: { runnable: false, reason: 'blocked_for_human', blockedBy: [] } }],
    });
    await invoke(['--parent', 'github:acme/prd#1']);
    const printed = mocks.detail.mock.calls.map(call => String(call[0]));
    expect(printed).toContain('github:acme/api#2: blocked_for_human');
  });

  it('passes the dispatch limits through to the scheduler', async () => {
    mocks.scheduleWorkItems.mockResolvedValue({ parent: 'github:acme/prd#1', capacity: 4, executions: [], waiting: [], stopped: false });
    await invoke(['--parent', 'github:acme/prd#1', '--max-concurrent', '4', '--load-limit', '16', '--poll-interval', '30000', '--watch']);
    expect(mocks.scheduleWorkItems).toHaveBeenCalledWith(expect.objectContaining({
      parent: 'github:acme/prd#1', maxConcurrent: 4, loadLimit: 16, pollIntervalMs: 30000, watch: true,
    }), { plugins: expect.objectContaining({ dispose: mocks.dispose }), agentProviderRegistry: mocks.registry });
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('disposes plugins and removes signal listeners when dispatch fails', async () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    mocks.scheduleWorkItems.mockRejectedValueOnce(new Error('dispatch failed'));
    await expect(invoke(['--parent', 'github:acme/prd#1'])).rejects.toThrow('dispatch failed');
    expect(mocks.dispose).toHaveBeenCalledOnce();
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});
