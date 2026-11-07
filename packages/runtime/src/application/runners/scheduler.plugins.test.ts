import { afterEach, expect, it, vi } from 'vitest';
import { PluginRuntime } from '../plugins/runtime.js';
import type { AgentProvider } from '../../domain/agents/index.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';
import { scheduleWorkItems } from './scheduler.js';
import { parseWorkItemId } from '../../domain/work-item/identity.js';
import type { GlobalWorkItem } from '../../domain/work-item/types.js';

vi.mock('../workflows/execute-work-item.js', () => ({ executeWorkItem: vi.fn() }));
afterEach(() => { vi.clearAllMocks(); });

it('dispatches the default executor with a runnable plugin provider and runtime', async () => {
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
  await plugins.activate({ id: 'scheduler-agent', version: '1.0.0', setup(context) { context.registerAgentProvider(agent.name, agent); } });
  const registry = plugins.getAgentProviderRegistry();
  const parent = parseWorkItemId('github:acme/scheduler#1').id;
  const workItemId = parseWorkItemId('github:acme/scheduler#2').id;
  const base: Omit<GlobalWorkItem, 'id' | 'issueNumber'> = {
    project: { platform: 'github', projectKey: 'acme/scheduler', name: 'scheduler' },
    title: 'Plugin work', branchName: 'plugin/work', providerRef: workItemId,
    managed: true, executionEligible: true, state: 'ready', executionMode: 'afk', dependsOn: [], tags: [],
  };
  vi.mocked(executeWorkItem).mockImplementation(async (input, dependencies) => {
    await dependencies!.agentProviderRegistry!.require(agent.name).createExecution({ worktreePath: '/workspace', prompt: 'implement' } as never);
    expect(dependencies!.plugins).toBe(plugins);
    return { ...input, executionId: 'plugin-attempt', status: 'merge_ready' };
  });
  try {
    const result = await scheduleWorkItems({ parent }, {
      plugins, agentProviderRegistry: registry,
      inventory: async () => ({
        items: [
          { ...base, id: parent, issueNumber: 1, kind: 'prd' },
          { ...base, id: workItemId, issueNumber: 2, parentId: parent },
        ] as GlobalWorkItem[],
        diagnostics: [{ platform: 'github', projectKey: 'other/repo', code: 'issue_list_failed', message: 'HTTP 503', retryable: true }],
      }),
      repositories: async () => ['github:acme/scheduler'], cores: 1, load: () => 0,
    });
    expect(createExecution).toHaveBeenCalledOnce();
    expect(executeWorkItem).toHaveBeenCalledWith({ workItemId }, { plugins, agentProviderRegistry: registry });
    expect(result.executions[0].status).toBe('merge_ready');
    expect(result.scope?.reported.map(diagnostic => diagnostic.projectKey)).toEqual(['other/repo']);
    expect(result.scope?.unreadable).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('getAgentProviderRegistry');
  } finally {
    await plugins.dispose();
  }
});
