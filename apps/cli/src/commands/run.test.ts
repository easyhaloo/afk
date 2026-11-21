import { afterEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

const mocks = vi.hoisted(() => ({
  runWorkflowCli: vi.fn(async () => ({ success: true })),
  getAgentProviderRegistry: vi.fn(() => { throw new Error('Agent registry accessed before routing'); }),
  resolveAgentProviderName: vi.fn(() => { throw new Error('Agent resolved before routing'); }),
  resolveAgentRuntimeOptions: vi.fn(() => { throw new Error('Agent runtime resolved before routing'); }),
  dispose: vi.fn(),
}));
vi.mock('@afk/runtime/plugin-sdk', () => ({ createDefaultPluginRuntime: async () => ({ getAgentProviderRegistry: mocks.getAgentProviderRegistry, dispose: mocks.dispose }) }));

vi.mock('@afk/runtime/application/workflows/run-cmd', () => ({ runWorkflowCli: mocks.runWorkflowCli }));
vi.mock('@afk/runtime/infrastructure/config/manager', () => ({
  getWorkflowConfig: () => ({
    agentDefault: 'claude-code',
    maxRetries: 2,
    workflowHardTimeout: 1000,
    contextThreshold: 100,
    goalBudget: 1000,
    agents: { codex: {} },
  }),
}));
vi.mock('@afk/runtime/domain/agents/index', () => ({
  defaultAgentProviderRegistry: {},
  resolveAgentProviderName: mocks.resolveAgentProviderName,
}));
vi.mock('./agent-runtime-options.js', async () => ({
  ...await vi.importActual<typeof import('./agent-runtime-options.js')>('./agent-runtime-options.js'),
  resolveAgentRuntimeOptions: mocks.resolveAgentRuntimeOptions,
}));
vi.mock('../output.js', () => ({
  handleCommandError: (error: unknown) => { throw error; },
  success: vi.fn(),
  warning: vi.fn(),
  detail: vi.fn(),
}));

import { registerRunCommands } from './run.js';

describe('run command', () => {
  afterEach(() => { vi.clearAllMocks(); });

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
      plugins: expect.anything(),
    }));
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });

  it('defers Agent defaults and validation until shared workflow routing', async () => {
    const program = new Command().name('afk').exitOverride();
    registerRunCommands(program);

    await program.parseAsync(['node', 'afk', 'run', '--backlog-id', 'github:acme/api#42']);

    expect(mocks.runWorkflowCli).toHaveBeenCalledWith(expect.objectContaining({ agentProvider: undefined }));
    expect(mocks.runWorkflowCli).not.toHaveBeenCalledWith(expect.objectContaining({ agentRuntime: expect.anything() }));
    expect(mocks.runWorkflowCli).not.toHaveBeenCalledWith(expect.objectContaining({ agentRuntimeOverrides: expect.anything() }));
    expect(mocks.getAgentProviderRegistry).not.toHaveBeenCalled();
    expect(mocks.resolveAgentProviderName).not.toHaveBeenCalled();
    expect(mocks.resolveAgentRuntimeOptions).not.toHaveBeenCalled();
  });

  it('passes explicit Agent and all raw Codex runtime overrides to shared routing', async () => {
    const program = new Command().name('afk').exitOverride();
    registerRunCommands(program);

    await program.parseAsync([
      'node', 'afk', 'run', '--backlog-id', 'github:acme/api#42', '--agent', 'codex',
      '--agent-transport', 'app-server', '--agent-auth', 'api', '--agent-provider', 'custom',
      '--agent-profile', 'work', '--agent-app-server', 'ws://127.0.0.1:4500',
      '--agent-app-server-auth-env', 'CODEX_TEST_TOKEN',
    ]);

    expect(mocks.runWorkflowCli).toHaveBeenCalledWith(expect.objectContaining({
      agentProvider: 'codex',
      agentRuntimeOverrides: {
        transport: 'app-server', auth: 'api', provider: 'custom', profile: 'work',
        endpoint: 'ws://127.0.0.1:4500', authTokenEnv: 'CODEX_TEST_TOKEN',
      },
    }));
    expect(mocks.resolveAgentRuntimeOptions).not.toHaveBeenCalled();
  });

  it('disposes its owned plugin runtime when shared routing fails', async () => {
    const failure = new Error('Learning workflow rejected explicit Agent');
    mocks.runWorkflowCli.mockRejectedValueOnce(failure);
    const program = new Command().name('afk').exitOverride();
    registerRunCommands(program);

    await expect(program.parseAsync([
      'node', 'afk', 'run', '--backlog-id', 'github:acme/api#42', '--template', 'learning',
    ])).rejects.toBe(failure);

    expect(mocks.runWorkflowCli).toHaveBeenCalledOnce();
    expect(mocks.dispose).toHaveBeenCalledOnce();
  });
});
