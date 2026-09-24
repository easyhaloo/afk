import { describe, expect, it } from 'vitest';
import { resolveWorkflowRequest, resolveWorkflowRunRequest } from './run-request';

describe('resolveWorkflowRequest', () => {
  it('uses CLI values over config values and defaults', () => {
    const request = resolveWorkflowRequest(
      { backlogId: 'feature/auth', targetBranch: 'release', executionMode: 'batch' },
      { targetBranch: 'develop', trackerTargetBranch: 'trunk', maxRetries: 4, goalBudget: 2_000_000 },
      { repoRoot: '/repo', projectName: 'org/repo' },
    );

    expect(request).toMatchObject({
      backlogId: 'feature/auth',
      repoRoot: '/repo',
      targetBranch: 'release',
      baseBranch: 'trunk',
      executionMode: 'batch',
      maxRetries: 4,
      session: 'afk-feature/auth',
      branchStrategy: { type: 'named', branch: 'afk/backlog-feature-auth' },
    });
  });

  it('uses a configured workflow template unless the CLI overrides it', () => {
    const configured = resolveWorkflowRequest({ backlogId: '42' }, { template: 'afk-control-workflow' });
    const overridden = resolveWorkflowRequest({ backlogId: '42', template: 'pre-merge-qa-verification' }, { template: 'afk-control-workflow' });

    expect(configured.template).toBe('afk-control-workflow');
    expect(overridden.template).toBe('pre-merge-qa-verification');
  });

  it('derives a branch from a string backlog ID', () => {
    const request = resolveWorkflowRequest({ backlogId: 'product/auth/login' }, {});
    expect(request.branchStrategy).toEqual({ type: 'named', branch: 'afk/backlog-product-auth-login' });
  });

  it('rejects invalid execution modes', () => {
    expect(() => resolveWorkflowRequest({ backlogId: '42', executionMode: 'stream' as any }, {} as any)).toThrow(/execution-mode/);
  });

  it('accepts registered provider names and rejects removed aliases', () => {
    expect(resolveWorkflowRequest({ backlogId: '42', agentProvider: 'codex' }, {})).toMatchObject({
      provider: 'codex',
      agentProvider: 'codex',
    });
    expect(() => resolveWorkflowRequest({ backlogId: '42', agentProvider: 'claude' as any }, {})).toThrow(/agent provider/);
  });

  it('resolves one immutable Codex runtime selection', () => {
    const agentRuntime = {
      kind: 'codex', transport: 'app-server', auth: 'chatgpt', provider: 'openai',
      endpoint: 'stdio://', startupTimeoutMs: 10_000,
    } as const;
    const request = resolveWorkflowRequest({ backlogId: '42', agentProvider: 'codex', agentRuntime }, {});

    expect(request.agentRuntime).toBe(agentRuntime);
  });

  it('uses the provider-neutral default runtime for non-Codex agents', () => {
    expect(resolveWorkflowRequest({ backlogId: '42', agentProvider: 'claude-code' }, {})).toMatchObject({
      agentRuntime: { kind: 'default' },
    });
  });

  it('projects the primary manifest repository while preserving the normalized collection', async () => {
    const request = await resolveWorkflowRunRequest(
      { backlogId: 'WI-2026-018', executionManifestPath: '/workspace/.afk/execution-manifest.json', template: 'custom' },
      {},
      {
        readFile: async () => JSON.stringify({
          schemaVersion: 1,
          workItemId: 'WI-2026-018',
          providerBacklogId: '42',
          tracker: { platform: 'github', projectKey: 'acme/api' },
          workingBranch: 'afk/work-item-42',
          repositories: [
            {
              platform: 'github', projectKey: 'acme/api', name: 'api', checkoutPath: 'repositories/api',
              baseBranch: 'main', workingBranch: 'afk/work-item-42', primary: true,
            },
            {
              platform: 'gitlab', projectKey: 'acme/web', providerProjectId: '202', name: 'web',
              checkoutPath: 'repositories/web', baseBranch: 'develop', role: 'frontend',
              workingBranch: 'afk/work-item-42', primary: false,
            },
          ],
        }),
      },
    );

    expect(request).toMatchObject({
      backlogId: '42',
      workItemId: 'WI-2026-018',
      session: 'afk-WI-2026-018',
      projectName: 'acme/api',
      trackerPlatform: 'github',
      trackerProjectId: 'acme/api',
      repoRoot: '/workspace/repositories/api',
      baseBranch: 'main',
      targetBranch: 'afk/work-item-42',
      branchStrategy: { type: 'named', branch: 'afk/work-item-42', baseBranch: 'main' },
      template: 'custom',
      repositories: [
        { platform: 'github', projectKey: 'acme/api', repoRoot: '/workspace/repositories/api', primary: true },
        { platform: 'gitlab', projectKey: 'acme/web', repoRoot: '/workspace/repositories/web', baseBranch: 'develop', primary: false },
      ],
    });
  });

  it.each([
    ['projectName', 'other/project', /--project conflicts/],
    ['baseBranch', 'develop', /--base-branch conflicts/],
    ['targetBranch', 'other-branch', /--target-branch conflicts/],
  ] as const)('rejects conflicting manifest and %s values', async (field, value, pattern) => {
    const input = {
      backlogId: 'github:acme/api#42',
      executionManifestPath: '/workspace/.afk/execution-manifest.json',
      [field]: value,
    };
    await expect(resolveWorkflowRunRequest(input, {}, {
      readFile: async () => JSON.stringify({
        schemaVersion: 1,
        workItemId: 'github:acme/api#42',
        providerBacklogId: '42',
        tracker: { platform: 'github', projectKey: 'acme/api' },
        workingBranch: 'afk/work-item-42',
        repositories: [{
          platform: 'github', projectKey: 'acme/api', name: 'api', checkoutPath: 'repositories/api',
          baseBranch: 'main', workingBranch: 'afk/work-item-42', primary: true,
        }],
      }),
    })).rejects.toThrow(pattern);
  });

  it('rejects an explicit branch strategy that conflicts with the manifest branch', async () => {
    await expect(resolveWorkflowRunRequest({
      backlogId: 'WI-2026-018',
      executionManifestPath: '/workspace/.afk/execution-manifest.json',
      branchStrategy: { type: 'named', branch: 'other', baseBranch: 'main' },
    }, {}, {
      readFile: async () => JSON.stringify({
        schemaVersion: 1,
        workItemId: 'WI-2026-018',
        providerBacklogId: '42',
        tracker: { platform: 'github', projectKey: 'acme/api' },
        workingBranch: 'afk/work-item-42',
        repositories: [{
          platform: 'github', projectKey: 'acme/api', name: 'api', checkoutPath: 'repositories/api',
          baseBranch: 'main', workingBranch: 'afk/work-item-42', primary: true,
        }],
      }),
    })).rejects.toThrow(/branch strategy conflicts/i);
  });

  it('derives explicit self-hosted GitLab tracker context without a git remote', async () => {
    const request = await resolveWorkflowRunRequest({
      backlogId: 'WI-2026-019',
      executionManifestPath: '/workspace/.afk/execution-manifest.json',
    }, {}, {
      readFile: async () => JSON.stringify({
        schemaVersion: 1,
        workItemId: 'WI-2026-019',
        providerBacklogId: '77',
        tracker: { platform: 'gitlab', projectKey: 'git.corp/team/platform/api', providerHost: 'git.corp' },
        workingBranch: 'afk/work-item-19',
        repositories: [{
          platform: 'gitlab', projectKey: 'git.corp/team/platform/api', providerHost: 'git.corp', name: 'api', checkoutPath: 'repositories/api',
          baseBranch: 'main', workingBranch: 'afk/work-item-19', primary: true,
        }],
      }),
    });

    expect(request).toMatchObject({
      backlogId: '77',
      workItemId: 'WI-2026-019',
      trackerPlatform: 'gitlab',
      trackerProjectId: 'team/platform/api',
      trackerHost: 'git.corp',
    });
  });

  it('keeps the no-manifest request path unchanged', async () => {
    const readFile = async () => { throw new Error('must not read'); };
    const request = await resolveWorkflowRunRequest(
      { backlogId: '42', repoRoot: '/repo', targetBranch: 'release' },
      { trackerTargetBranch: 'trunk' },
      { cwd: '/invocation', readFile },
    );

    expect(request).toMatchObject({
      backlogId: '42',
      repoRoot: '/repo',
      originalCwd: '/invocation',
      targetBranch: 'release',
      baseBranch: 'trunk',
      repositories: undefined,
    });
  });

  it('never infers a GitLab host from a dotted namespace path', async () => {
    const request = await resolveWorkflowRunRequest(
      { backlogId: 'WI-1', executionManifestPath: '/workspace/.afk/execution-manifest.json' },
      {},
      { readFile: async () => JSON.stringify({
        schemaVersion: 1, workItemId: 'WI-1', providerBacklogId: '1', workingBranch: 'afk/wi-1',
        tracker: { platform: 'gitlab', projectKey: 'team.platform/subgroup/repo' },
        repositories: [{
          platform: 'gitlab', projectKey: 'team.platform/subgroup/repo', name: 'repo', checkoutPath: 'repositories/repo',
          baseBranch: 'main', workingBranch: 'afk/wi-1', primary: true,
        }],
      }) },
    );

    expect(request).toMatchObject({ trackerProjectId: 'team.platform/subgroup/repo' });
    expect(request.trackerHost).toBeUndefined();
  });
});
