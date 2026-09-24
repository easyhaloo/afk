import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { registerBacklogCommands } from './backlog';
import { registerQACommands } from './qa';
import { createManagementProviders } from '../../application/tracker-provider-factory';
import { QARunner } from '../../application/modules/qa-runner';

vi.mock('../../application/tracker-provider-factory', () => ({
  createManagementProviders: vi.fn(),
}));
vi.mock('../cli-utils', () => ({
  handleCommandError: (error: unknown) => { throw error; },
  success: vi.fn(), info: vi.fn(), warning: vi.fn(), fail: vi.fn(), detail: vi.fn(),
}));
vi.mock('../../infrastructure/config/manager', () => ({
  getSchedulerConfig: () => ({ maxConcurrent: 3, pollInterval: 60 }),
  getWorkflowConfig: () => ({}),
}));
vi.mock('../../domain/agents/index', () => ({
  createAgentProvider: vi.fn(),
  prepareAgentRuntime: vi.fn(() => ({})),
  resolveAgentProviderName: vi.fn(() => 'claude-code'),
}));
vi.mock('./agent-runtime-options', () => ({
  addAgentRuntimeOptions: (command: Command) => command,
  resolveAgentRuntimeOptions: () => ({}),
}));
vi.mock('../../application/modules/qa-runner', () => ({ QARunner: vi.fn() }));

async function runCommand(register: (program: Command) => void, ...args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  register(program);
  await program.parseAsync(['node', 'afk', ...args]);
}

describe('canonical command provider wiring', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('uses the canonical management bundle for backlog administration', async () => {
    const initialize = vi.fn().mockResolvedValue(undefined);
    vi.mocked(createManagementProviders).mockResolvedValue({ backlog: { initialize } } as never);

    await runCommand(registerBacklogCommands, 'backlog', 'init', '--project', 'group/repo');

    expect(createManagementProviders).toHaveBeenCalledWith('group/repo', undefined, undefined);
    expect(initialize).toHaveBeenCalledOnce();
  });

  it('uses the canonical management bundle for QA without claiming work', async () => {
    const backlog = { get: vi.fn().mockResolvedValue({ id: 'item-1', state: 'verification' }) };
    const providers = { backlog };
    const processItem = vi.fn().mockResolvedValue({ success: true, mrUrl: 'https://example.com/mr/1' });
    vi.mocked(createManagementProviders).mockResolvedValue(providers as never);
    vi.mocked(QARunner).mockImplementation(() => ({ process: processItem }) as never);

    await runCommand(registerQACommands, 'qa', '--backlog-id', 'item-1', '--project', 'group/repo', '--mode', 'interactive');

    expect(createManagementProviders).toHaveBeenCalledWith('group/repo', process.cwd());
    expect(backlog.get).toHaveBeenCalledWith('item-1');
    expect(QARunner).toHaveBeenCalledWith(providers, expect.anything(), {
      executionMode: 'interactive',
      agentProvider: undefined,
      agentRuntime: expect.anything(),
    });
    expect(processItem).toHaveBeenCalledWith('item-1');
  });
});
