import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({ executeWorkItem: vi.fn(), reconcileWorkItemMerge: vi.fn() }));
vi.mock('../../application/workflows/execute-work-item', () => ({ executeWorkItem: mocks.executeWorkItem, reconcileWorkItemMerge: mocks.reconcileWorkItemMerge }));
vi.mock('../cli-utils', () => ({
  handleCommandError: (error: unknown) => { throw error; }, success: vi.fn(), warning: vi.fn(), detail: vi.fn(),
}));

import { registerExecuteCommands } from './execute';

async function invoke(argv: string[], command = 'execute') {
  const program = new Command().name('afk').exitOverride();
  registerExecuteCommands(program);
  await program.parseAsync(['node', 'afk', command, ...argv]);
}

describe('execute CLI', () => {
  afterEach(() => { vi.clearAllMocks(); process.exitCode = 0; });
  const argv = ['--work-item-id', 'github:acme/api#42', '--execution-manifest', '/tmp/item.json', '--template', 'custom'];

  it('accepts the desktop argv without a backlog ID', async () => {
    mocks.executeWorkItem.mockResolvedValue({ status: 'merge_ready', changeUrl: 'https://example.test/pr/1' });
    await invoke(argv);
    expect(mocks.executeWorkItem).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'github:acme/api#42', manifestPath: '/tmp/item.json', template: 'custom',
    }));
    expect(process.exitCode ?? 0).toBe(0);
  });

  it.each(['rework', 'blocked', 'not_claimed'])('exits nonzero on %s', async status => {
    mocks.executeWorkItem.mockResolvedValue({ status });
    await invoke(argv);
    expect(process.exitCode).toBe(1);
  });

  it('exits zero for an eligible merged child', async () => {
    mocks.executeWorkItem.mockResolvedValue({ status: 'done' });
    await invoke(argv);
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('reconciles a root PR by explicit attempt ID without rerunning implementation', async () => {
    mocks.reconcileWorkItemMerge.mockResolvedValue({ status: 'done', changeUrl: 'https://example.test/pr/1' });
    await invoke(['--work-item-id', 'github:acme/api#42', '--execution-manifest', '/tmp/item.json', '--execution-id', 'attempt-1'], 'reconcile');
    expect(mocks.reconcileWorkItemMerge).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'github:acme/api#42', executionId: 'attempt-1', manifestPath: '/tmp/item.json',
    }));
    expect(mocks.executeWorkItem).not.toHaveBeenCalled();
  });

  it('does not report a pending human merge as a completed reconciliation', async () => {
    mocks.reconcileWorkItemMerge.mockResolvedValue({ status: 'merge_ready' });
    await invoke(['--work-item-id', 'github:acme/api#42', '--execution-manifest', '/tmp/item.json', '--execution-id', 'attempt-1'], 'reconcile');
    expect(process.exitCode).toBe(1);
  });
});
