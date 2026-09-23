import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  runWorkflowCli: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../application/workflows/run-cmd', () => ({ runWorkflowCli: mocks.runWorkflowCli }));
vi.mock('../../infrastructure/config/manager', () => ({
  getWorkflowConfig: () => ({
    agentDefault: 'claude-code',
    maxRetries: 2,
    workflowHardTimeout: 1000,
    contextThreshold: 100,
    goalBudget: 1000,
    agents: { codex: {} },
  }),
}));
vi.mock('../../domain/agents/index', () => ({ resolveAgentProviderName: () => 'claude-code' }));
vi.mock('./agent-runtime-options', () => ({
  addAgentRuntimeOptions: (command: Command) => command,
  resolveAgentRuntimeOptions: () => ({ kind: 'default' }),
}));
vi.mock('../cli-utils', () => ({
  handleCommandError: (error: unknown) => { throw error; },
  success: vi.fn(),
  warning: vi.fn(),
  detail: vi.fn(),
}));

import { registerRunCommands } from './run';

describe('run command', () => {
  afterEach(() => vi.clearAllMocks());

  it('accepts --execution-manifest and passes it to runWorkflowCli', async () => {
    const program = new Command().name('afk').exitOverride();
    registerRunCommands(program);

    await program.parseAsync([
      'node', 'afk', 'run', '--backlog-id', 'github:acme/api#42',
      '--execution-manifest', '/workspace/.afk/execution-manifest.json',
    ]);

    expect(mocks.runWorkflowCli).toHaveBeenCalledWith(expect.objectContaining({
      backlogId: 'github:acme/api#42',
      executionManifestPath: '/workspace/.afk/execution-manifest.json',
    }));
  });
});
