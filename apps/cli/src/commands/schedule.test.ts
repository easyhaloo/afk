import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({ scheduleWorkItems: vi.fn(), detail: vi.fn(), warning: vi.fn() }));
vi.mock('@afk/runtime/execution', async importOriginal => ({
  ...(await importOriginal<typeof import('@afk/runtime/execution')>()),
  scheduleWorkItems: mocks.scheduleWorkItems,
}));
vi.mock('../output.js', () => ({
  handleCommandError: (error: unknown) => { throw error; }, success: vi.fn(), warning: mocks.warning, detail: mocks.detail,
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
    }));
  });

  it('names the projects it cannot read, inside and outside the scope', async () => {
    mocks.scheduleWorkItems.mockImplementation(async (options: { onStatus?: (status: unknown) => void }) => {
      options.onStatus?.({
        active: 0, capacity: 4, overloaded: false,
        scope: {
          reported: [{ platform: 'github', projectKey: 'other/repo', code: 'issue_list_failed', message: 'Repository access blocked', retryable: false }],
          unreadable: [{ platform: 'github', projectKey: 'acme/base', code: 'issue_list_failed', message: 'HTTP 503', retryable: true }],
          heldBack: ['github:acme/web#3'],
        },
      });
      return {
        parent: 'github:acme/prd#1', capacity: 4, executions: [], stopped: false, waiting: [],
        scope: {
          reported: [{ platform: 'github', projectKey: 'other/repo', code: 'issue_list_failed', message: 'Repository access blocked', retryable: false }],
          unreadable: [{ platform: 'github', projectKey: 'acme/base', code: 'issue_list_failed', message: 'HTTP 503', retryable: true }],
          heldBack: ['github:acme/web#3'],
        },
      };
    });
    await invoke(['--parent', 'github:acme/prd#1']);
    const warnings = mocks.warning.mock.calls.map(call => String(call[0]));
    expect(warnings).toContain('Cannot read other/repo (Repository access blocked); it is outside this PRD\'s scope, so the schedule continues');
    expect(warnings).toContain('Cannot read acme/base (HTTP 503); it is inside this PRD\'s scope, so the work that depends on it is held back');
    const printed = mocks.detail.mock.calls.map(call => String(call[0]));
    expect(printed).toContain('Held back because a dependency could not be read: github:acme/web#3');
  });
});
