import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { AgentExecution, AgentProvider } from '../../domain/agents/types.js';
import type { BacklogClaim, BacklogItem } from '../../domain/backlog/index.js';
import type { Sandbox, SandboxProvider } from '../../infrastructure/sandbox/types.js';
import type { ProviderBundle } from '../../infrastructure/provider/providers.js';
import type { RunObserver } from '../../observability/run-observer.js';
import { WorkflowRunner } from '../workflow-engine.js';
import type { PreparedRepositorySet } from './multi-repository-preparer.js';
import { resolveWorkflowRunRequest } from './run-request.js';
import { executionWorkspacePath } from '../../infrastructure/workspace.js';
import { assertWorkspaceOwnershipAvailable, RunResourceScope, type ExecutionCleanupOwnership } from './resource-scope.js';

const observer = { record: vi.fn(async () => undefined) } as unknown as RunObserver;
let workspaceRoot: string;
beforeEach(async () => { workspaceRoot = await mkdtemp(join(tmpdir(), 'afk-manifest-runner-')); vi.mocked(observer.record).mockClear(); });
afterEach(async () => { await rm(workspaceRoot, { recursive: true, force: true }); });
const projectKey = (name: string) => `fixture-${basename(workspaceRoot)}/${name}`;

vi.mock('../runners/project-resolver.js', () => ({ default: () => ({ name: 'project-resolver' }) }));
vi.mock('simple-git', async importOriginal => ({
  ...await importOriginal<typeof import('simple-git')>(),
  simpleGit: vi.fn(() => ({ revparse: vi.fn(async () => 'baseline') })),
}));

describe('execution manifest request to runner boundary', () => {
  it('carries the manifest baseline as the execution baseline of the request', async () => {
    const request = await resolveWorkflowRunRequest({
      backlogId: 'WI-2026-018',
      executionManifestPath: '/workspace/.afk/execution-manifest.json',
    }, {}, {
      readFile: async () => JSON.stringify({
        schemaVersion: 1,
        workItemId: 'WI-2026-018',
        providerBacklogId: '42',
        tracker: { platform: 'github', projectKey: projectKey('api') },
        workingBranch: 'afk/work-item-18',
        repositories: [{
          platform: 'github', projectKey: projectKey('api'), name: 'api', checkoutPath: 'repositories/api',
          baseBranch: '2025-11-8-show', workingBranch: 'afk/work-item-18', primary: true,
        }],
      }),
    });

    expect(request.executionBaseBranch).toBe('2025-11-8-show');
  });

  it('claims the provider backlog id and keeps the manifest working branch', async () => {
    const request = await resolveWorkflowRunRequest({
      backlogId: 'WI-2026-018',
      executionManifestPath: '/workspace/.afk/execution-manifest.json',
    }, {}, {
      readFile: async () => JSON.stringify({
        schemaVersion: 1,
        workItemId: 'WI-2026-018',
        providerBacklogId: '42',
        tracker: { platform: 'github', projectKey: projectKey('api') },
        workingBranch: 'afk/work-item-18',
        repositories: [{
          platform: 'github', projectKey: projectKey('api'), name: 'api', checkoutPath: 'repositories/api',
          baseBranch: 'main', workingBranch: 'afk/work-item-18', primary: true,
        }],
      }),
    });
    const claimedItem: BacklogItem = {
      id: '42', title: 'Provider issue', dependsOn: [], tags: [], state: 'in_progress', executionMode: 'afk',
      branchName: 'afk/backlog-42', providerRef: `github:${projectKey('api')}#42`,
    };
    const release = vi.fn(async () => undefined);
    const claim: BacklogClaim = { item: claimedItem, claimId: 'claim-42', heartbeat: async () => undefined, release };
    const claimBacklog = vi.fn(async () => claim);
    const providers = {
      backlog: {
        claim: claimBacklog, transition: vi.fn(async () => undefined), setExecutionMode: vi.fn(async () => undefined),
        get: vi.fn(async () => claimedItem), list: vi.fn(), isRunnable: vi.fn(), getActiveRework: vi.fn(),
      },
      branches: { createBranch: vi.fn(), push: vi.fn(), commit: vi.fn(async () => ({ sha: '', skippedBinaryFiles: [] })), cleanup: vi.fn() },
      changes: { create: vi.fn(), get: vi.fn(), findForBacklog: vi.fn(), merge: vi.fn(), close: vi.fn() },
    } as unknown as ProviderBundle;
    const agent = { name: 'claude-code', capabilities: new Set() } as unknown as AgentProvider;
    const manifestRepositories = request.repositories!;
    const preparedRepositories = manifestRepositories.map(repository => ({
      ...repository,
      handle: { branch: repository.workingBranch, path: repository.repoRoot, isNewBranch: true },
      createdByRun: true,
      original: { branch: repository.baseBranch, head: 'head', status: '', workingBranchExisted: false },
    }));
    const runner = new WorkflowRunner(providers, {
      observer,
      agentProvider: agent,
      multiRepositoryPreparer: {
        prepare: vi.fn(async () => ({
          repositories: preparedRepositories,
          primary: preparedRepositories[0],
          finish: vi.fn(async () => undefined),
          release: vi.fn(async () => undefined),
        })),
      },
    }) as any;
    runner.runBody = vi.fn(async () => ({ success: true }));

    await expect(runner.run(request)).resolves.toMatchObject({ success: true });

    expect(claimBacklog).toHaveBeenCalledWith('42', 'afk-WI-2026-018');
    expect(runner.activeBacklog).toMatchObject({ id: '42', branchName: 'afk/work-item-18' });
    expect(runner.runBody).toHaveBeenCalledWith(expect.objectContaining({
      branchStrategy: { type: 'named', branch: 'afk/work-item-18', baseBranch: 'main' },
      workspaceRoot: executionWorkspacePath('WI-2026-018'),
    }));
  });

  it('adopts the prepared primary and starts sandbox, watchdog, and agent only afterward', async () => {
    const events: string[] = [];
    const repositories = [
      {
        platform: 'github' as const, projectKey: projectKey('api'), name: 'api', checkoutPath: 'repositories/api',
        repoRoot: '/workspace/repositories/api', baseBranch: 'main', workingBranch: 'afk/work-item-18', primary: true,
      },
      {
        platform: 'github' as const, projectKey: projectKey('web'), name: 'web', checkoutPath: 'repositories/web',
        repoRoot: '/workspace/repositories/web', baseBranch: 'develop', workingBranch: 'afk/work-item-18', primary: false,
      },
    ];
    const finish = vi.fn(async () => undefined);
    const prepared: PreparedRepositorySet = {
      repositories: repositories.map(repository => ({
        ...repository,
        handle: { branch: repository.workingBranch, path: repository.repoRoot, isNewBranch: true },
        createdByRun: true,
        original: { branch: repository.baseBranch, head: 'head', status: '', workingBranchExisted: false },
      })),
      primary: undefined as never,
      finish,
      release: vi.fn(async () => undefined),
    };
    prepared.primary = prepared.repositories[0];
    let ownership: ExecutionCleanupOwnership | undefined;
    const preparer = { prepare: vi.fn(async (_repositories: unknown, root: string, authority?: ExecutionCleanupOwnership) => {
      ownership = authority;
      expect(authority?.claims).toHaveLength(3);
      expect(authority?.claims).toEqual(runner.resourceScope.ownershipClaims);
      expect(() => authority!.assertClosed()).not.toThrow();
      await expect(assertWorkspaceOwnershipAvailable(root, repositories)).rejects.toThrow('quarantined');
      await assertWorkspaceOwnershipAvailable(root, repositories, authority!.claims);
      events.push('prepared'); return prepared;
    }) };
    const sandbox = sandboxWith(events);
    const sandboxProvider = providerWith(sandbox, events, 'docker');
    const agent = agentWith(events);
    const watchdog = { arm: vi.fn(() => events.push('watchdog')), disarm: vi.fn() };
    const providers = providersForRun();
    const runner = new WorkflowRunner(providers, {
      observer,
      agentProvider: agent,
      sandboxProvider,
      watchdog: watchdog as never,
      multiRepositoryPreparer: preparer,
      runtimeManager: runtimeManager() as never,
    }) as any;
    runner.autoWrapup = vi.fn(async () => ({ success: true }));

    await expect(runner.run({
      backlogId: '42', workItemId: 'WI-2026-018', session: 'afk-WI-2026-018', targetBranch: 'afk/work-item-18',
      baseBranch: 'main', repoRoot: repositories[0].repoRoot, workspaceRoot, repositories,
      sandboxProvider: 'docker', template: 'simple-loop', executionMode: 'batch',
    })).resolves.toMatchObject({ success: true });

    expect(preparer.prepare).toHaveBeenCalledWith(repositories, workspaceRoot, ownership);
    expect(runner.resourceScope.ownershipClaims).toEqual([]);
    await assertWorkspaceOwnershipAvailable(workspaceRoot, repositories);
    expect(providers.branches.createBranch).not.toHaveBeenCalled();
    expect(sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: repositories[0].repoRoot,
      workspaceRoot,
    }));
    expect(repositories[1].repoRoot.startsWith('/workspace/')).toBe(true);
    const prompt = vi.mocked(agent.createExecution).mock.calls[0][0].prompt;
    expect(prompt).toContain('Execution repositories');
    expect(prompt).toContain('1. primary checkoutPath=repositories/api baseBranch=main targetBranch=main workingBranch=afk/work-item-18');
    expect(prompt).toContain('2. secondary checkoutPath=repositories/web baseBranch=develop targetBranch=develop workingBranch=afk/work-item-18');
    expect(prompt).toContain('Paths are relative to the execution workspace root');
    expect(prompt).not.toContain('/workspace/repositories');
    expect(events.indexOf('prepared')).toBeLessThan(events.indexOf('sandbox'));
    expect(events.indexOf('prepared')).toBeLessThan(events.indexOf('watchdog'));
    expect(events.indexOf('prepared')).toBeLessThan(events.indexOf('agent'));
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith({ status: 'success' });
    expect(prepared.release).not.toHaveBeenCalled();
    expect(observer.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      kind: 'workflow.recorded', name: 'simple-loop', version: 1,
      steps: expect.arrayContaining([expect.objectContaining({ kind: 'agent', dependsOn: [] })]),
    }));
  });

  it.each([false, true])('finalizes both repositories before QA, with secondary push failure=%s', async failSecondary => {
    const events: string[] = [];
    const repositories = ['api', 'web'].map((name, index) => ({
      platform: 'github' as const, projectKey: projectKey(name), name, checkoutPath: `repositories/${name}`,
      repoRoot: `/workspace/repositories/${name}`, baseBranch: 'main', workingBranch: 'afk/work-item-18', primary: index === 0,
    }));
    const preparedRepositories = repositories.map(repository => ({
      ...repository,
      handle: { branch: repository.workingBranch, path: repository.repoRoot, isNewBranch: true },
      createdByRun: true,
      original: { branch: repository.baseBranch, head: 'head', status: '', workingBranchExisted: false },
    }));
    let finalization: Promise<void> | undefined;
    const publicationError = new Error('secondary push failed');
    let cleanupAllowed = false;
    const finish = vi.fn((outcome: { status: string }) => {
      if (cleanupAllowed && outcome.status === 'failed') {
        events.push('retained-cleanup-confirmed');
        return Promise.resolve();
      }
      finalization ??= (async () => {
        events.push('push-api');
        events.push('push-web');
        if (failSecondary) throw publicationError;
        events.push('checkout-cleaned');
      })();
      return finalization;
    });
    const providers = providersForRun();
    const runtime = runtimeManager();
    vi.mocked(providers.backlog.transition).mockImplementation(async (_id, state) => { events.push(`transition-${state}`); });
    const runner = new WorkflowRunner(providers, {
      observer,
      agentProvider: agentWith(events), sandboxProvider: providerWith(sandboxWith(events), events),
      watchdog: { arm: vi.fn(), disarm: vi.fn() } as never,
      runtimeManager: runtime as never,
      multiRepositoryPreparer: { prepare: vi.fn(async () => ({
        repositories: preparedRepositories, primary: preparedRepositories[0], finish,
        release: vi.fn(async () => undefined),
      })) },
    }) as any;
    runner.runStep = vi.fn(async (step: { id: string }) => ({ stepId: step.id, status: 'completed' }));
    runner.runLifecycleHooks = vi.fn(async (hooks: string[]) => {
      if (hooks.includes('after')) events.push('after-hooks');
    });

    const operation = runner.run({
      backlogId: '42', session: 'worker-42', targetBranch: 'afk/work-item-18', baseBranch: 'main',
      repoRoot: repositories[0].repoRoot, workspaceRoot, repositories,
      template: 'issue-implementation', executionMode: 'batch',
    });

    const result = await operation.catch((error: unknown) => error);
    expect(finish).toHaveBeenCalledWith({ status: 'success' });
    expect(events.indexOf('after-hooks')).toBeLessThan(events.indexOf('push-api'));
    expect(events.indexOf('push-api')).toBeLessThan(events.indexOf('push-web'));
    if (failSecondary) {
      const failure = result as AggregateError & { cause: { implementationHandedOff: boolean; runError: unknown; recovery: { scope: RunResourceScope } } };
      const retained = runner.resourceScope as RunResourceScope;
      try {
        expect(failure).toBeInstanceOf(AggregateError);
        expect(failure.errors).toEqual([publicationError]);
        expect(failure.message).toContain('repository publication failed: secondary push failed');
        expect(failure.message).toContain('workflow terminal cleanup failed: secondary push failed');
        expect(failure.cause.implementationHandedOff).toBe(false);
        expect(failure.cause.runError).toBeUndefined();
        expect(failure.cause.recovery.scope).toBe(retained);
        expect(finish.mock.calls.map(([outcome]) => outcome.status)).toEqual(['success', 'failed', 'failed']);
        expect(retained.ownershipClaims).toHaveLength(3);
        const claim = await vi.mocked(providers.backlog.claim).mock.results[0].value;
        expect(claim!.release).not.toHaveBeenCalled();
        await expect(assertWorkspaceOwnershipAvailable(workspaceRoot, repositories)).rejects.toThrow('quarantined');
        await assertWorkspaceOwnershipAvailable(workspaceRoot, repositories, retained.ownershipClaims);
        expect(runtime.finish).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({
          status: 'blocked', errorSummary: expect.stringContaining('cleanup ownership unconfirmed'),
        }));
        expect(observer.record).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'implementation.completed' }));
        cleanupAllowed = true;
        await failure.cause.recovery.scope.finish({ status: 'failed' });
        expect(retained.ownershipClaims).toEqual([]);
        expect(claim!.release).toHaveBeenCalledTimes(1);
        await assertWorkspaceOwnershipAvailable(workspaceRoot, repositories);
        expect(events.filter(event => event === 'push-api')).toHaveLength(1);
        expect(events.filter(event => event === 'push-web')).toHaveLength(1);
        expect(events.filter(event => event === 'retained-cleanup-confirmed')).toHaveLength(1);
      } finally {
        cleanupAllowed = true;
        await retained.finish({ status: 'failed' });
      }
      expect(events).not.toContain('checkout-cleaned');
      expect(events).not.toContain('transition-verification');
      expect(events).toContain('transition-blocked');
      expect(providers.backlog.transition).toHaveBeenCalledWith('42', 'blocked', {
        reason: 'repository publication failed: secondary push failed',
      });
      expect(providers.backlog.setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
    } else {
      expect(result).toMatchObject({ success: true });
      expect(finish).toHaveBeenCalledTimes(1);
      expect(runner.resourceScope.ownershipClaims).toEqual([]);
      await assertWorkspaceOwnershipAvailable(workspaceRoot, repositories);
      expect(events.indexOf('push-web')).toBeLessThan(events.indexOf('checkout-cleaned'));
      expect(events.indexOf('push-web')).toBeLessThan(events.indexOf('transition-verification'));
    }
  });

  it('does not start branch, sandbox, watchdog, or agent resources when preparation fails', async () => {
    const events: string[] = [];
    const preparationError = new Error('secondary preparation failed');
    const preparer = { prepare: vi.fn(async () => { throw preparationError; }) };
    const sandboxProvider = providerWith(sandboxWith(events), events);
    const agent = agentWith(events);
    const watchdog = { arm: vi.fn(), disarm: vi.fn() };
    const providers = providersForRun();
    const runner = new WorkflowRunner(providers, {
      observer,
      agentProvider: agent,
      sandboxProvider,
      watchdog: watchdog as never,
      multiRepositoryPreparer: preparer,
      runtimeManager: runtimeManager() as never,
    });
    const repositories = [{
      platform: 'github' as const, projectKey: projectKey('api'), name: 'api', checkoutPath: 'repositories/api',
      repoRoot: '/workspace/repositories/api', baseBranch: 'main', workingBranch: 'afk/work-item-18', primary: true,
    }];

    await expect(runner.run({
      backlogId: '42', session: 'afk-WI-2026-018', targetBranch: 'afk/work-item-18', baseBranch: 'main',
      repoRoot: repositories[0].repoRoot, workspaceRoot, repositories, template: 'simple-loop', executionMode: 'batch',
    })).rejects.toBe(preparationError);

    expect(preparer.prepare).toHaveBeenCalledTimes(1);
    const claim = await vi.mocked(providers.backlog.claim).mock.results[0].value;
    expect(claim!.release).toHaveBeenCalledTimes(1);
    await assertWorkspaceOwnershipAvailable(workspaceRoot, repositories);
    expect(providers.branches.createBranch).not.toHaveBeenCalled();
    expect(sandboxProvider.create).not.toHaveBeenCalled();
    expect(watchdog.arm).not.toHaveBeenCalled();
    expect(agent.createExecution).not.toHaveBeenCalled();
  });

  it('keeps the legacy createBranch flow when repositories are absent', async () => {
    const events: string[] = [];
    const sandboxProvider = providerWith(sandboxWith(events), events);
    const providers = providersForRun();
    vi.mocked(providers.branches.createBranch).mockResolvedValue({
      branchName: 'afk/backlog-42', worktreePath: '/legacy/worktree',
    });
    const runner = new WorkflowRunner(providers, {
      observer,
      agentProvider: agentWith(events), sandboxProvider, watchdog: { arm: vi.fn(), disarm: vi.fn() } as never,
      runtimeManager: runtimeManager() as never,
    }) as any;
    runner.autoWrapup = vi.fn(async () => ({ success: true }));

    await runner.run({
      backlogId: '42', session: 'worker-42', targetBranch: 'afk/backlog-42', baseBranch: 'main',
      repoRoot: '/legacy/repo', workspaceRoot, template: 'simple-loop', executionMode: 'batch',
    });

    expect(providers.branches.createBranch).toHaveBeenCalledTimes(1);
    expect(sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({
      worktreePath: '/legacy/worktree', workspaceRoot,
    }));
  });
});

function providersForRun(): ProviderBundle {
  const item: BacklogItem = {
    id: '42', title: 'Provider issue', dependsOn: [], tags: [], state: 'in_progress', executionMode: 'afk',
    branchName: 'afk/backlog-42', providerRef: `github:${projectKey('api')}#42`,
  };
  const claim: BacklogClaim = {
    item, claimId: 'claim-42', heartbeat: vi.fn(async () => undefined), release: vi.fn(async () => undefined),
  };
  return {
    backlog: {
      claim: vi.fn(async () => claim), transition: vi.fn(async () => undefined), setExecutionMode: vi.fn(async () => undefined),
      get: vi.fn(async () => item), list: vi.fn(), isRunnable: vi.fn(), getActiveRework: vi.fn(async () => undefined),
    },
    branches: {
      createBranch: vi.fn(), createVerificationWorktree: vi.fn(), push: vi.fn(), commit: vi.fn(async () => ({ sha: '', skippedBinaryFiles: [] })), cleanup: vi.fn(),
    },
    changes: { create: vi.fn(), get: vi.fn(), findForBacklog: vi.fn(), merge: vi.fn(), close: vi.fn() },
  } as unknown as ProviderBundle;
}

function sandboxWith(events: string[]): Sandbox {
  return {
    id: 'sandbox-1', worktreePath: '/unused', workspacePath: '/unused',
    startAgent: vi.fn(), close: vi.fn(async () => undefined),
  } as unknown as Sandbox;
}

function providerWith(sandbox: Sandbox, events: string[], name: 'local' | 'docker' = 'local'): SandboxProvider {
  return {
    name, isolation: 'workspace', capabilities: new Set(), createWorktree: vi.fn(),
    create: vi.fn(async () => { events.push('sandbox'); return sandbox; }),
  } as unknown as SandboxProvider;
}

function agentWith(events: string[]): AgentProvider {
  const execution: AgentExecution = {
    id: 'execution-1', metadata: { provider: 'claude-code', transport: 'process' },
    waitForEvent: vi.fn(async () => null),
    waitForResult: vi.fn(async (): ReturnType<AgentExecution['waitForResult']> => ({
      version: 1, runId: 'execution-1', status: 'completed', provider: 'test', commits: [],
      structuredOutput: { type: 'goal_complete', kind: 'task', summary: 'done' },
    })),
    interrupt: vi.fn(async () => undefined), kill: vi.fn(async () => undefined),
    captureOutput: vi.fn(async () => ''), captureSession: vi.fn(async () => undefined),
    resume: vi.fn(async () => { throw new Error('unsupported'); }),
  };
  return {
    name: 'claude-code', capabilities: new Set(),
    createExecution: vi.fn(async () => { events.push('agent'); return execution; }),
  };
}

function runtimeManager() {
  return {
    start: vi.fn(async () => undefined), heartbeat: vi.fn(async () => undefined), finish: vi.fn(async () => undefined),
    writeDiagnostics: vi.fn(async () => undefined), appendActivity: vi.fn(async () => undefined),
  };
}
