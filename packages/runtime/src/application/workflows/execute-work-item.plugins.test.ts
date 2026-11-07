import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginRuntime } from '../plugins/runtime.js';
import { AgentProviderRegistry, type AgentProvider } from '../../domain/agents/index.js';
import { executeWorkItem } from './execute-work-item.js';
import { resolveWorkflowRequest, resolveWorkflowRunRequest } from './run-request.js';
import { assembleProviders } from '../../infrastructure/provider/assembly.js';
import { WorkflowRunner } from '../workflow-engine.js';
import { QARunner } from '../runners/qa-runner.js';
import type { BacklogItem } from '../../domain/backlog/index.js';

vi.mock('../workflow-engine.js', () => ({ WorkflowRunner: vi.fn() }));
vi.mock('../runners/qa-runner.js', () => ({ QARunner: vi.fn() }));
vi.mock('../../infrastructure/provider/assembly.js', () => ({ assembleProviders: vi.fn() }));
vi.mock('./run-request.js', async importOriginal => ({
  ...await importOriginal<typeof import('./run-request.js')>(), resolveWorkflowRunRequest: vi.fn(),
}));

describe('managed execution plugin dependencies', () => {
  const workItemId = 'github:acme/plugin#42';
  let directory: string;
  let plugins: PluginRuntime;
  let current: BacklogItem;
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
    directory = await mkdtemp(join(tmpdir(), 'execution-plugins-'));
    plugins = new PluginRuntime();
    await plugins.activate({ id: 'execution-providers', version: '1.0.0', setup(context) {
      context.registerAgentProvider(agent.name, agent);
      context.registerSandboxProvider(sandbox.id, sandbox as never);
    } });
    current = {
      id: workItemId, title: 'Plugin work', managed: true, executionEligible: true,
      dependsOn: [], state: 'ready', executionMode: 'afk', tags: [],
      branchName: 'plugin/42', providerRef: workItemId,
    };
    const providers = {
      backlog: { get: async () => current, isRunnable: async () => true, setExecutionMode: vi.fn() },
      branches: {},
      changes: {
        findForBacklog: async () => current.state === 'merge_ready'
          ? { id: '5', state: 'open', url: 'https://example.test/5' } : null,
        verifyIssueAssociation: vi.fn(),
      },
    };
    vi.mocked(assembleProviders).mockResolvedValue({ providers } as never);
    vi.mocked(resolveWorkflowRunRequest).mockImplementation(async (input, config, dependencies) => resolveWorkflowRequest({
      ...input, backlogId: '42',
    }, config, { repoRoot: directory, projectName: 'acme/plugin', originalCwd: directory }, dependencies?.agentProviderRegistry));
    vi.mocked(WorkflowRunner).mockImplementation(function (_providers, dependencies) {
      return { run: async (request: Parameters<WorkflowRunner['run']>[0]) => {
        await dependencies!.agentProviderRegistry!.require(request.agentProvider!).createExecution({
          worktreePath: directory, prompt: 'implement', executionMode: request.executionMode,
        } as never);
        current.state = 'verification';
        return { success: true };
      } } as never;
    });
    vi.mocked(QARunner).mockImplementation(function (_providers, _config, dependencies) {
      return { process: async () => {
        await dependencies!.agentProvider!.createExecution({ worktreePath: directory, prompt: 'verify', executionMode: 'interactive' } as never);
        current.state = 'merge_ready';
        return { success: true, mrUrl: 'https://example.test/5' };
      } } as never;
    });
  });

  afterEach(async () => {
    await plugins.dispose();
    await rm(directory, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it.each([false, true])('uses the same plugin registry through context, implementation and QA (explicit=%s)', async explicit => {
    const registry = explicit ? new AgentProviderRegistry([agent]) : undefined;
    const recordAudit = vi.fn();
    const result = await executeWorkItem({
      workItemId, executionId: 'plugin-attempt', manifestPath: join(directory, 'manifest.json'),
      runOptions: { backlogId: workItemId, agentProvider: agent.name, sandboxProvider: sandbox.id },
    }, {
      plugins, agentProviderRegistry: registry,
      readManifest: async () => ({
        workItemId, providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'acme/plugin' },
        workspaceRoot: directory, manifestPath: join(directory, 'manifest.json'),
      } as never),
      lookupWorkItem: async () => ({
        ...current, id: workItemId, issueNumber: 42,
        project: { platform: 'github', projectKey: 'acme/plugin', name: 'plugin' },
      } as never),
      recordAudit,
    });
    expect(result.status).toBe('merge_ready');
    expect(createExecution).toHaveBeenCalledTimes(2);
    const resolvedRegistry = vi.mocked(resolveWorkflowRunRequest).mock.calls[0][2]!.agentProviderRegistry;
    if (registry) expect(resolvedRegistry).toBe(registry);
    else expect(resolvedRegistry!.listNames()).toEqual([agent.name]);
    expect(WorkflowRunner).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ plugins, agentProviderRegistry: resolvedRegistry }));
    expect(QARunner).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({
      plugins, agentProvider: agent, agentProviderRegistry: resolvedRegistry, sandboxProvider: sandbox,
    }));
    expect(assembleProviders).toHaveBeenCalledWith(expect.objectContaining({ plugins }));
    expect(recordAudit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'human_gate.opened' }));
  });

  it('rejects a builtin agent excluded from the plugin runtime instead of restoring it from the default registry', async () => {
    vi.mocked(WorkflowRunner).mockImplementation(() => ({ run: vi.fn(async () => ({ success: false })) }) as never);
    const result = executeWorkItem({
      workItemId, executionId: 'disabled-agent-attempt', manifestPath: join(directory, 'manifest.json'),
      runOptions: { backlogId: workItemId, agentProvider: 'claude-code', sandboxProvider: sandbox.id },
    }, {
      plugins,
      readManifest: async () => ({
        workItemId, providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'acme/plugin' },
        workspaceRoot: directory, manifestPath: join(directory, 'manifest.json'),
      } as never),
      lookupWorkItem: async () => ({
        ...current, id: workItemId, issueNumber: 42,
        project: { platform: 'github', projectKey: 'acme/plugin', name: 'plugin' },
      } as never),
      recordAudit: vi.fn(),
    });
    await expect(result).rejects.toThrow(/agent provider not registered: claude-code/);
    expect(WorkflowRunner).not.toHaveBeenCalled();
    expect(QARunner).not.toHaveBeenCalled();
    expect(createExecution).not.toHaveBeenCalled();
  });
});
