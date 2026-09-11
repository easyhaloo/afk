import { describe, expect, it } from 'vitest';
import { resolveWorkflowRequest } from './run-request';

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
});
