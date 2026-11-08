import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';
import { PluginRuntime, createDefaultPluginRuntime } from '@afk/runtime/plugin-sdk';
import { getWorkflowConfig } from '@afk/runtime/infrastructure/config/manager';
import { resolveWorkflowRunRequest } from '@afk/runtime/execution';
import { assembleProviders } from '@afk/runtime/infrastructure/provider/assembly';
import { QARunner } from '@afk/runtime/application/runners/qa-runner';
import type { AgentProvider } from '@afk/runtime/domain/agents/index';
import { registerQACommands } from './qa.js';
import { handleCommandError } from '../output.js';

vi.mock('@afk/runtime/plugin-sdk', async importOriginal => ({
  ...await importOriginal<typeof import('@afk/runtime/plugin-sdk')>(), createDefaultPluginRuntime: vi.fn(),
}));
vi.mock('@afk/runtime/infrastructure/provider/assembly', () => ({ assembleProviders: vi.fn() }));
vi.mock('@afk/runtime/application/runners/qa-runner', () => ({ QARunner: vi.fn() }));
vi.mock('@afk/runtime/execution', async importOriginal => ({
  ...await importOriginal<typeof import('@afk/runtime/execution')>(), resolveWorkflowRunRequest: vi.fn(),
}));
vi.mock('../output.js', () => ({
  handleCommandError: vi.fn((error: unknown) => { throw error; }), success: vi.fn(), warning: vi.fn(), detail: vi.fn(),
}));

async function invoke(...args: string[]) {
  const program = new Command().name('afk').exitOverride();
  registerQACommands(program);
  await program.parseAsync(['node', 'afk', 'qa', '--backlog-id', 'github:acme/api#42', ...args]);
}

describe('QA plugin execution', () => {
  let plugins: PluginRuntime;
  const createExecution = vi.fn(async () => ({
    id: 'plugin-execution', metadata: { provider: 'plugin-agent', transport: 'process' as const },
    waitForEvent: async () => null,
    waitForResult: async () => ({ version: 1 as const, runId: 'plugin-execution', status: 'completed' as const, provider: 'plugin-agent', commits: [] }),
    interrupt: async () => undefined, kill: async () => undefined,
    captureOutput: async () => '', captureSession: async () => undefined,
    resume: async () => { throw new Error('resume unsupported'); },
  }));
  const agent: AgentProvider = { name: 'plugin-agent', capabilities: new Set(), createExecution };
  const sandbox = { id: 'plugin-sandbox', capabilities: new Set() };

  beforeEach(async () => {
    plugins = new PluginRuntime();
    await plugins.activate({
      id: 'test-qa-providers', version: '1.0.0',
      setup(context) {
        context.registerAgentProvider(agent.name, agent);
        context.registerSandboxProvider(sandbox.id, sandbox as never);
      },
    });
    vi.spyOn(plugins, 'dispose');
    vi.mocked(createDefaultPluginRuntime).mockResolvedValue(plugins);
    vi.mocked(resolveWorkflowRunRequest).mockImplementation(async (input, _config, dependencies) => {
      dependencies?.agentProviderRegistry?.require(input.agentProvider!);
      return {
        backlogId: '42', workItemId: 'github:acme/api#42', agentProvider: input.agentProvider,
        sandboxProvider: sandbox.id, workspaceRoot: '/workspace', repoRoot: '/workspace/repo',
        trackerPlatform: 'github', trackerProjectId: 'acme/api', trackerProjectKey: 'acme/api',
      } as never;
    });
    vi.mocked(assembleProviders).mockResolvedValue({
      management: { backlog: { get: vi.fn(async () => ({ id: '42', state: 'verification' })) } },
    } as never);
    vi.mocked(QARunner).mockImplementation(function (_providers, _config, dependencies) {
      return { process: async () => {
        await dependencies!.agentProvider!.createExecution({ worktreePath: '/workspace/repo', prompt: 'verify', executionMode: 'batch' } as never);
        return { success: true };
      } } as never;
    });
  });

  afterEach(async () => {
    await plugins.dispose();
    vi.clearAllMocks();
    process.exitCode = 0;
  });

  it.each(['batch', 'interactive'])('runs an explicitly selected plugin agent with its sandbox in %s mode', async mode => {
    await invoke('--agent', agent.name, '--mode', mode);
    expect(createExecution).toHaveBeenCalledOnce();
    expect(assembleProviders).toHaveBeenCalledWith(expect.objectContaining({ plugins }));
    expect(QARunner).toHaveBeenCalledWith(expect.anything(), getWorkflowConfig(), expect.objectContaining({
      plugins, agentProvider: agent, sandboxProvider: sandbox, executionMode: mode,
    }));
    expect(plugins.dispose).toHaveBeenCalledOnce();
  });

  it('releases plugins when the item is not awaiting verification', async () => {
    vi.mocked(assembleProviders).mockResolvedValueOnce({
      management: { backlog: { get: async () => ({ id: '42', state: 'ready' }) } },
    } as never);
    await expect(invoke('--agent', agent.name)).rejects.toThrow('QA requires verification state');
    expect(QARunner).not.toHaveBeenCalled();
    expect(plugins.dispose).toHaveBeenCalledOnce();
    expect(vi.mocked(plugins.dispose).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(handleCommandError).mock.invocationCallOrder[0]);
  });

  it('rejects unknown agents rather than using a static fallback', async () => {
    await expect(invoke('--agent', 'missing-agent')).rejects.toThrow('missing-agent');
    expect(createExecution).not.toHaveBeenCalled();
    expect(plugins.dispose).toHaveBeenCalledOnce();
  });
});
