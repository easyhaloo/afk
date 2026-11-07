import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { PluginRuntime } from '../plugins/runtime.js';
import type { AgentProvider } from '../../domain/agents/index.js';
import type { ProviderBundle } from '../../infrastructure/provider/providers.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';
import { LoopRunner } from './loop-runner.js';

vi.mock('../workflows/execute-work-item.js', () => ({ executeWorkItem: vi.fn() }));

it('runs the default managed executor with the caller plugin dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'loop-plugin-'));
  const plugins = new PluginRuntime();
  const createExecution = vi.fn(async () => ({
    id: 'plugin-execution', metadata: { provider: 'plugin-agent', transport: 'process' as const },
    waitForEvent: async () => null,
    waitForResult: async () => ({ version: 1 as const, runId: 'plugin-execution', status: 'completed' as const, provider: 'plugin-agent', commits: [] }),
    interrupt: async () => undefined, kill: async () => undefined,
    captureOutput: async () => '', captureSession: async () => undefined,
    resume: async () => { throw new Error('resume unsupported'); },
  }));
  const agent: AgentProvider = { name: 'plugin-agent', capabilities: new Set(), createExecution };
  await plugins.activate({ id: 'loop-agent', version: '1.0.0', setup(context) { context.registerAgentProvider(agent.name, agent); } });
  const registry = plugins.getAgentProviderRegistry();
  const workItemId = 'github:acme/loop#42';
  const item = { id: '42', state: 'ready', executionMode: 'afk', dependsOn: [], providerRef: workItemId };
  const providers = {
    backlog: {
      get: async () => item,
      list: async ({ state }: { state: string }) => state === 'ready' ? [item] : [],
      isRunnable: async () => true,
      explainRunnability: async () => ({ runnable: true, blockedBy: [] }),
    },
    changes: { findForBacklog: async () => null }, branches: {},
  } as unknown as ProviderBundle;
  vi.mocked(executeWorkItem).mockImplementation(async (input, dependencies) => {
    await dependencies!.agentProviderRegistry!.require(agent.name).createExecution({ worktreePath: directory, prompt: 'implement' } as never);
    expect(dependencies!.plugins).toBe(plugins);
    return { ...input, executionId: 'plugin-attempt', status: 'merge_ready' };
  });
  const runner = new LoopRunner(providers, {
    plugins, agentProviderRegistry: registry, backlogIds: ['42'], managedExecution: { workItemId },
    maxIterations: 1, pollIntervalMs: 60000, statusIntervalMs: 60000,
    pidFilePath: join(directory, 'loop.pid'), statusFilePath: join(directory, 'loop.json'),
  });
  try {
    await runner.start();
    expect(createExecution).toHaveBeenCalledOnce();
    expect(executeWorkItem).toHaveBeenCalledWith({ workItemId, template: undefined }, { plugins, agentProviderRegistry: registry });
    expect(runner.getStatus().totals.completed).toBe(1);
    expect(JSON.stringify(runner.getStatus())).not.toContain('getAgentProviderRegistry');
  } finally {
    await runner.stop();
    await plugins.dispose();
    await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  }
});
