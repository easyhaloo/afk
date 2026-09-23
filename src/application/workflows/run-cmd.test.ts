import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: { maxRetries: 2 },
  request: {
    backlogId: '42',
    workItemId: 'WI-2026-018',
    projectName: 'acme/api',
    trackerPlatform: 'github',
    trackerProjectId: 'acme/api',
    repoRoot: '/workspace/repositories/api',
    originalCwd: '/invocation',
    session: 'afk-42',
    targetBranch: 'afk/work-item-42',
    baseBranch: 'main',
    maxRetries: 2,
    hardTimeoutMs: 1000,
    completionTimeoutMs: 1000,
    maxHandoffs: 1,
    contextHighTokens: 100,
    maxTotalTokens: 1000,
    provider: 'claude-code',
    agentProvider: 'claude-code',
    sandboxProvider: 'local',
    executionMode: 'batch',
    agentRuntime: { kind: 'default' },
    branchStrategy: { type: 'named', branch: 'afk/work-item-42', baseBranch: 'main' },
    repositories: [
      {
        platform: 'github', projectKey: 'acme/api', name: 'api', checkoutPath: 'repositories/api',
        repoRoot: '/workspace/repositories/api', baseBranch: 'main', workingBranch: 'afk/work-item-42', primary: true,
      },
      {
        platform: 'gitlab', projectKey: 'acme/web', name: 'web', checkoutPath: 'repositories/web',
        repoRoot: '/workspace/repositories/web', baseBranch: 'develop', workingBranch: 'afk/work-item-42', primary: false,
      },
    ],
  },
  runnerRun: vi.fn(async () => ({ success: true, url: 'https://example.test/change/42' })),
  createTracker: vi.fn(async () => ({ platform: 'github' })),
  createProviderBundle: vi.fn(() => ({ backlog: {}, branches: {}, changes: {} })),
}));

vi.mock('../workflow-engine', () => ({
  WorkflowRunner: class {
    run = mocks.runnerRun;
  },
}));
vi.mock('../tracker-provider-factory', () => ({ createTracker: mocks.createTracker }));
vi.mock('../providers', () => ({ createProviderBundle: mocks.createProviderBundle }));
vi.mock('../../infrastructure/config/manager', () => ({ getWorkflowConfig: () => mocks.config }));
vi.mock('../../domain/agents/codex-runtime', () => ({ prepareAgentRuntime: async (runtime: unknown) => runtime }));
vi.mock('./run-request', () => ({ resolveWorkflowRunRequest: async () => mocks.request }));

import { runWorkflowCli } from './run-cmd';

describe('runWorkflowCli', () => {
  it('passes the normalized repository collection to WorkflowRunner', async () => {
    await expect(runWorkflowCli({
      backlogId: 'WI-2026-018',
      executionManifestPath: '/workspace/.afk/execution-manifest.json',
    })).resolves.toEqual({ success: true, url: 'https://example.test/change/42' });

    expect(mocks.createTracker).toHaveBeenCalledWith('acme/api', '/workspace/repositories/api', 'github', undefined);
    expect(mocks.createProviderBundle).toHaveBeenCalledWith(expect.anything(), '/workspace/repositories/api');
    expect(mocks.runnerRun).toHaveBeenCalledWith(expect.objectContaining({
      repositories: mocks.request.repositories,
      backlogId: '42',
      workItemId: 'WI-2026-018',
      repoRoot: '/workspace/repositories/api',
      targetBranch: 'afk/work-item-42',
    }));
  });
});
