import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDefaultPluginRuntime } from './default-runtime.js';
import { WorkflowRunner } from '../workflow-engine.js';
import { QARunner } from '../runners/qa-runner.js';
import { getWorkflowConfig } from '../../infrastructure/config/manager.js';
import type { RepositoryProvider, RepositoryWorkspace, ProviderOperationOptions } from '../../plugin-sdk/capabilities.js';
import type { ProviderBundle } from '../../infrastructure/provider/providers.js';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { SandboxProvider } from '../../infrastructure/sandbox/types.js';
import type { WorkflowRunRepository } from '../workflows/run-request.js';
import { assertWorkspaceOwnershipAvailable, type RunResourceScope } from '../workflows/resource-scope.js';

const gitState = vi.hoisted(() => new Map<string, { commit: string; branch: string }>());
vi.mock('simple-git', async original => ({ ...await original<typeof import('simple-git')>(), simpleGit: vi.fn((path: string) => ({
  revparse: vi.fn(async (args: string[]) => args.includes('--abbrev-ref') ? gitState.get(path)?.branch : gitState.get(path)?.commit),
  status: vi.fn(async () => ({ isClean: () => true })),
  raw: vi.fn(async () => ''), log: vi.fn(async () => ({ all: [] })),
})) }));
vi.mock('../runners/project-resolver.js', () => ({ default: () => ({ name: 'project-resolver' }) }));
const roots: string[] = [];
const runtimes: Awaited<ReturnType<typeof createDefaultPluginRuntime>>[] = [];
afterEach(async () => { await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose())); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); gitState.clear(); });

type Kind = 'workflow' | 'qa';
async function fixture(kind: Kind, selected = 'alpha') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-repository-routing-')));
  roots.push(root);
  await mkdir(join(root, '.afk'));
  await writeFile(join(root, '.afk', 'plugins.yml'), JSON.stringify({ integrations: { repository: { provider: selected } } }));
  const plugins = await createDefaultPluginRuntime({ homeDir: root, workspaceRoot: root });
  runtimes.push(plugins);
  const lease = new AsyncLocalStorage<string>();
  const events: string[] = [];
  const handles = new Map<string, RepositoryWorkspace>();
  const signals: Array<NonNullable<ProviderOperationOptions>['signal']> = [];
  const cleanupSignals: Array<NonNullable<ProviderOperationOptions>['signal']> = [];
  const controls = { cleanup: true, fail: '', pending: undefined as Promise<void> | undefined, executionPending: false, sourceCommit: undefined as string | undefined };
  const providers = await Promise.all(['alpha', 'beta'].map(async (id, index) => {
    const path = join(root, id);
    await mkdir(path);
    const commit = String(index + 1).repeat(40);
    const checkoutBranch = kind === 'qa' ? 'feat/task-qa' : 'feat/task';
    gitState.set(path, { commit, branch: checkoutBranch });
    const provider: RepositoryProvider = {
      id, capabilities: { read: true, clone: true, push: true, prepare: true, checkout: true, publish: true, cleanup: true },
      snapshot: vi.fn(async () => ({ ...gitState.get(path)!, dirty: false })),
      withLifecycleLease: async (_request, operation) => lease.run(id, async () => { events.push(id + ':lease'); try { return await operation(); } finally { events.push(id + ':release'); } }),
      prepare: vi.fn(async (request, options) => {
        signals.push(options?.signal); events.push(id + ':prepare');
        if (controls.pending) await controls.pending;
        if (controls.fail === 'prepare') throw new Error('prepare refused');
        const workspace = { id: id + '-handle', repository: request.repository, runId: request.runId, path, snapshot: { commit, branch: request.repository.ref!, dirty: false } };
        handles.set(workspace.id, workspace); return workspace;
      }),
      checkout: vi.fn(async (request, options) => {
        signals.push(options?.signal); events.push(id + ':checkout');
        if (controls.fail === 'checkout') throw new Error('checkout refused');
        const workspace = handles.get(request.workspaceId)!;
        const snapshot = { commit: controls.sourceCommit ?? commit, branch: request.branch ?? `afk/${workspace.runId}`, dirty: false };
        gitState.set(path, snapshot);
        return { ...workspace, snapshot };
      }),
      publish: vi.fn(async (_request, options) => { signals.push(options?.signal); expect(lease.getStore()).toBe(id); events.push(id + ':publish'); if (controls.fail === 'publish') throw new Error('publish refused'); return { ...gitState.get(path)! }; }),
      cleanup: vi.fn(async (_request, options) => { cleanupSignals.push(options?.signal); expect(lease.getStore()).toBe(id); events.push(id + ':cleanup'); return { removed: controls.cleanup }; }),
    };
    await plugins.activate({ id: 'fixture.' + id, version: '1.0.0', setup(context) { context.registerRepositoryProvider(id, provider); } });
    return provider;
  }));
  await plugins.activate({ id: 'fixture.workflow', version: '1.0.0', setup(context) { context.registerWorkflowTemplate({ name: 'repository-routing', version: 1, steps: [{ id: 'work', kind: 'agent', role: 'developer', prompt: 'Complete the task.' }] }); } });
  const repository: WorkflowRunRepository = { platform: 'github', projectKey: 'fixture/' + root.split('/').at(-1), name: 'api', checkoutPath: 'repositories/api', repoRoot: join(root, 'default'), baseBranch: 'main', workingBranch: 'feat/task', primary: true };
  const item = { id: '42', providerRef: '42', title: 'Repository routing', kind: 'task', state: kind === 'qa' ? 'verification' : 'ready', executionMode: 'afk', branchName: 'feat/task', dependsOn: [], tags: [] };
  const claimRelease = vi.fn(async () => { events.push('claim:release'); });
  const branches = { createBranch: vi.fn(async () => { throw new Error('default branch used'); }), createVerificationWorktree: vi.fn(async () => { throw new Error('default QA used'); }),
    mergeFeatureIntoBaseline: vi.fn(async () => ({ merged: true, conflicts: [] })), commit: vi.fn(async () => ({ sha: '', skippedBinaryFiles: [] })), push: vi.fn(async () => {}), cleanup: vi.fn(async () => {}) };
  const change = { id: 'pr42', url: 'https://fixture.test/42', state: 'open', sourceBranch: kind === 'qa' ? 'feat/task-qa' : 'feat/task', targetBranch: 'main', mergeState: 'mergeable' };
  const bundle = { backlog: { get: vi.fn(async () => ({ ...item })), claim: vi.fn(async () => ({ item, heartbeat: async () => {}, release: claimRelease })), getActiveRework: vi.fn(async () => undefined), transition: vi.fn(async () => {}), setExecutionMode: vi.fn(async () => {}) }, branches,
    changes: { findForBacklog: vi.fn(async () => null), create: vi.fn(async () => change), get: vi.fn(async () => change) } };
  const execution = { id: 'fake', metadata: { provider: 'claude-code', transport: 'process' }, waitForResult: vi.fn(async () => ({ version: 1, runId: 'fake', provider: 'fixture', status: 'completed', commits: [], structuredOutput: { type: 'goal_complete', kind: kind === 'qa' ? 'qa' : 'task', result: 'PASS', summary: 'done' } })), kill: vi.fn(async () => { if (controls.executionPending) throw new Error('owned execution stop unconfirmed'); }), pending: () => controls.executionPending, captureOutput: vi.fn(async () => ''), captureSession: vi.fn(async () => undefined) };
  const agent = { name: 'claude-code', capabilities: new Set(), createExecution: vi.fn(async () => execution) };
  const sandbox = { id: 'fake', worktreePath: '', close: vi.fn(async () => {}) };
  const sandboxProvider = { name: 'local', create: vi.fn(async () => sandbox) };
  const fallback = { prepare: vi.fn(async () => { throw new Error('default preparer used'); }) };
  const runtimeManager = { start: vi.fn(async (_run: { runId: string }) => {}), heartbeat: vi.fn(async () => {}), finish: vi.fn(async () => {}), writeDiagnostics: vi.fn(async () => {}) };
  const config = { ...getWorkflowConfig(), workflowHardTimeout: 60000, qaTimeout: 60000, maxRetries: 0 };
  const common = { plugins, runtimeManager: runtimeManager as never, agentProvider: agent as unknown as AgentProvider, sandboxProvider: sandboxProvider as unknown as SandboxProvider };
  const runner = kind === 'workflow' ? new WorkflowRunner(bundle as unknown as ProviderBundle, { ...common, config, multiRepositoryPreparer: fallback, observer: { record: vi.fn(async () => {}) } as never, watchdog: { arm: vi.fn(), disarm: vi.fn() } as never })
    : new QARunner(bundle as unknown as ProviderBundle, config, { ...common, projectRoot: root, repositories: [repository], prepareRepositories: fallback });
  const run = (options: ProviderOperationOptions = {}) => kind === 'workflow'
    ? (runner as WorkflowRunner).run({ backlogId: '42', session: 'exact-run-42', observationRunId: 'exact-run-42', observationWorkItemId: 'github:fixture/api#42', targetBranch: 'feat/task', baseBranch: 'main', baseBranchExplicit: true, repoRoot: repository.repoRoot, workspaceRoot: root, repositories: [repository], template: 'repository-routing', executionMode: 'batch', ...options })
    : (runner as QARunner).process('42', options);
  return { root, plugins, providers, run, fallback, agent, branches, bundle, events, handles, signals, cleanupSignals, controls, runner, claimRelease, sandboxProvider, execution, runtimeManager, repository };
}

describe.each<Kind>(['workflow', 'qa'])('%s selected Repository production routing', kind => {
  it.each(['alpha', 'beta'])('executes and publishes in %s checkout without default preparation', async selected => {
    const f = await fixture(kind, selected);
    expect(await f.run()).toMatchObject({ success: true });
    expect(f.fallback.prepare).not.toHaveBeenCalled();
    expect(f.branches.createBranch).not.toHaveBeenCalled();
    expect(f.branches.createVerificationWorktree).not.toHaveBeenCalled();
    expect(f.branches.push).not.toHaveBeenCalled();
    expect(f.sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: join(f.root, selected) }));
    const chosen = f.providers[selected === 'alpha' ? 0 : 1];
    expect(chosen.publish).toHaveBeenCalledTimes(1);
    expect(chosen.cleanup).toHaveBeenCalledTimes(1);
    expect(f.providers[selected === 'alpha' ? 1 : 0].prepare).not.toHaveBeenCalled();
    expect(f.events.indexOf(selected + ':cleanup')).toBeLessThan(f.events.indexOf(selected + ':release'));
    expect(f.cleanupSignals.every(signal => signal && !signal.aborted)).toBe(true);
    expect(f.signals.every(signal => signal === f.signals[0])).toBe(true);
    const prepared = vi.mocked(chosen.prepare!).mock.calls[0][0];
    expect(prepared.repository).toEqual({ url: 'api', ref: 'main' });
    expect(chosen.checkout).toHaveBeenCalledWith({ workspaceId: selected + '-handle', branch: kind === 'qa' ? 'feat/task-qa' : 'feat/task',
      ...(kind === 'qa' ? { ref: 'feat/task' } : {}) }, expect.anything());
    expect(prepared.runId).toBe(kind === 'qa' ? vi.mocked(f.runtimeManager.start).mock.calls[0][0].runId : 'exact-run-42');
  });
  it.each(['unknown', 'disabled', 'unsupported', 'unavailable', 'lease-missing', 'integration-disabled'])('fails closed for %s selection', async condition => {
    const f = await fixture(kind, condition === 'unknown' ? 'missing' : 'alpha');
    if (condition === 'disabled') await f.plugins.dispose('fixture.alpha');
    if (condition === 'unsupported') Object.assign(f.providers[0].capabilities, { checkout: false });
    if (condition === 'unavailable') f.providers[0].health = async () => ({ status: 'unavailable' });
    if (condition === 'lease-missing') f.providers[0].withLifecycleLease = undefined;
    if (condition === 'integration-disabled') await f.plugins.dispose('workflow.integrations');
    const result = await f.run().catch(error => ({ success: false, summary: String(error) }));
    expect(result.success).toBe(false);
    expect(f.fallback.prepare).not.toHaveBeenCalled();
    expect(f.agent.createExecution).not.toHaveBeenCalled();
    expect(f.bundle.changes.create).not.toHaveBeenCalled();
  });
  it.each(['prepare', 'checkout', 'publish'])('keeps %s failure and never falls back', async phase => {
    const f = await fixture(kind);
    f.controls.fail = phase;
    const result = await f.run().catch(error => ({ success: false, summary: String(error) }));
    expect(result.success).toBe(false);
    expect(f.fallback.prepare).not.toHaveBeenCalled();
    expect(f.branches.push).not.toHaveBeenCalled();
    if (phase !== 'prepare') expect(f.providers[0].cleanup).toHaveBeenCalled();
    else {
      expect(f.events).not.toContain('alpha:release');
      await expect(assertWorkspaceOwnershipAvailable(f.root, [f.repository])).rejects.toThrow('quarantined');
    }
    expect(f.bundle.changes.create).not.toHaveBeenCalled();
  });
  it.each(['revision', 'run', 'repository', 'branch', 'path'])('rejects a checkout with mismatched %s', async mismatch => {
    const f = await fixture(kind);
    const checkout = f.providers[0].checkout!;
    f.providers[0].checkout = async (request, options) => {
      const workspace = await checkout(request, options);
      if (mismatch === 'revision') gitState.set(workspace.path!, { commit: 'f'.repeat(40), branch: workspace.snapshot.branch });
      return { ...workspace, ...(mismatch === 'run' ? { runId: 'wrong-run' } : {}),
        ...(mismatch === 'repository' ? { repository: { url: 'other-project' } } : {}),
        ...(mismatch === 'path' ? { path: join(f.root, 'beta') } : {}),
        snapshot: { ...workspace.snapshot, ...(mismatch === 'branch' ? { branch: 'wrong-branch' } : {}) } };
    };
    expect((await f.run().catch(error => ({ success: false, error }))).success).toBe(false);
    expect(f.agent.createExecution).not.toHaveBeenCalled();
    expect(f.providers[0].cleanup).toHaveBeenCalledTimes(1);
    expect(f.fallback.prepare).not.toHaveBeenCalled();
  });
  it('rejects a lifecycle lease that never invokes its operation', async () => {
    const f = await fixture(kind);
    f.providers[0].withLifecycleLease = async () => undefined as never;
    expect((await f.run().catch(error => ({ success: false, error }))).success).toBe(false);
    expect(f.providers[0].prepare).not.toHaveBeenCalled();
    expect(f.fallback.prepare).not.toHaveBeenCalled();
  });
  it('blocks publication after selected Provider revocation and cleans the owned handle', async () => {
    const f = await fixture(kind);
    const result = await f.execution.waitForResult();
    f.execution.waitForResult.mockImplementation(async () => { await f.plugins.dispose('fixture.alpha'); return result; });
    expect((await f.run().catch(error => ({ success: false, error }))).success).toBe(false);
    expect(f.providers[0].publish).not.toHaveBeenCalled();
    expect(f.providers[0].cleanup).toHaveBeenCalledTimes(1);
    expect(f.bundle.changes.create).not.toHaveBeenCalled();
  });
  it('ignores ordinary JSON execution context lookalikes', async () => {
    const f = await fixture(kind);
    expect(await f.run({ worktreePath: join(f.root, 'beta'), repositoryWorkspace: { id: 'spoof', path: join(f.root, 'beta'), snapshot: { commit: 'f'.repeat(40) } } } as ProviderOperationOptions)).toMatchObject({ success: true });
    expect(f.sandboxProvider.create).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: join(f.root, 'alpha') }));
    await expect(f.plugins.dispatchSystemAction('work-item.execute', { workItemId: 'github:fixture/api#42', worktreePath: join(f.root, 'beta') })).rejects.toThrow();
  });
  it('retains the selected allocation while an owned execution remains unclosed', async () => {
    const f = await fixture(kind);
    f.controls.executionPending = true;
    const failure = await f.run().catch(error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(f.providers[0].cleanup).not.toHaveBeenCalled();
    expect(f.events).not.toContain('alpha:release');
    await expect(assertWorkspaceOwnershipAvailable(f.root, [f.repository])).rejects.toThrow('quarantined');
    f.controls.executionPending = false;
    await (failure as AggregateError & { cause: { recovery: { scope: RunResourceScope } } }).cause.recovery.scope.finish({ status: 'failed' });
    expect(f.providers[0].cleanup).toHaveBeenCalledTimes(1);
  });
  it('cancels the selected Agent phase and cleans only after execution closure', async () => {
    const f = await fixture(kind);
    let resolve!: (value: Awaited<ReturnType<typeof f.execution.waitForResult>>) => void;
    f.execution.waitForResult.mockImplementation(() => new Promise(done => { resolve = done; }));
    f.execution.kill.mockImplementation(async () => { resolve({ version: 1, runId: 'fake', provider: 'fixture', status: 'interrupted', commits: [] } as never); });
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal }).catch(error => ({ success: false, error }));
    await vi.waitFor(() => expect(f.execution.waitForResult).toHaveBeenCalled());
    caller.abort(new Error('stop selected Agent'));
    expect((await pending).success).toBe(false);
    expect(f.providers[0].publish).not.toHaveBeenCalled();
    expect(f.providers[0].cleanup).toHaveBeenCalledTimes(1);
    expect(f.execution.kill).toHaveBeenCalled();
  });
  it('cleans a late prepare handle on caller cancellation without checkout or publication', async () => {
    const f = await fixture(kind);
    let release!: () => void;
    f.controls.pending = new Promise<void>(resolve => { release = resolve; });
    const caller = new AbortController();
    const pending = f.run({ signal: caller.signal }).catch(error => ({ success: false, summary: String(error) }));
    await vi.waitFor(() => expect(f.providers[0].prepare).toHaveBeenCalled());
    caller.abort(new Error('trusted stop'));
    release();
    expect((await pending).success).toBe(false);
    expect(f.providers[0].checkout).not.toHaveBeenCalled();
    expect(f.providers[0].publish).not.toHaveBeenCalled();
    expect(f.providers[0].cleanup).toHaveBeenCalledTimes(1);
    expect(f.cleanupSignals.every(signal => signal && !signal.aborted)).toBe(true);
    expect(f.events.at(-1)).toBe(kind === 'workflow' ? 'claim:release' : 'alpha:release');
  });
  it('retains workspace and lease on refused cleanup, then retries through the owning scope', async () => {
    const f = await fixture(kind);
    f.controls.cleanup = false;
    const failure = await f.run().catch(error => error as AggregateError);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(String(failure)).toContain('cleanup ownership unconfirmed');
    expect(f.events).not.toContain('alpha:release');
    await expect(assertWorkspaceOwnershipAvailable(f.root, [f.repository])).rejects.toThrow('quarantined');
    const scope = (failure as AggregateError).cause as { recovery: { scope: RunResourceScope } };
    f.controls.cleanup = true;
    await scope.recovery.scope.finish({ status: 'failed' });
    expect(f.events).toContain('alpha:release');
    await assertWorkspaceOwnershipAvailable(f.root, [f.repository]);
  });
});

describe('D04 independent branch/ref contracts', () => {
  it('rejects an unrelated QA checkout branch before Agent and publication', async () => {
    const f = await fixture('qa');
    const checkout = f.providers[0].checkout!;
    f.providers[0].checkout = async (request, options) => {
      const workspace = await checkout(request, options);
      const branch = 'qa/other-task';
      gitState.set(workspace.path!, { commit: workspace.snapshot.commit, branch });
      return { ...workspace, snapshot: { ...workspace.snapshot, branch } };
    };
    f.providers[0].publish = vi.fn(async () => ({ commit: '1'.repeat(40), branch: 'qa/other-task' }));
    const result = await f.run().catch(error => ({ success: false, error }));
    expect(f.agent.createExecution).not.toHaveBeenCalled();
    expect(f.providers[0].publish).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
  it('rejects different manifest and backlog implementation refs before QA', async () => {
    const f = await fixture('qa');
    f.repository.workingBranch = 'feat/other-task';
    const result = await f.run().catch(error => ({ success: false, error }));
    expect(f.agent.createExecution).not.toHaveBeenCalled();
    expect(f.providers[0].publish).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });
});

describe('D04 trusted QA branch controls', () => {
  it('keeps the implementation ref and actual QA run while publishing the trusted QA branch', async () => {
    const f = await fixture('qa');
    expect(await f.run()).toMatchObject({ success: true });
    expect(f.repository.workingBranch).toBe('feat/task');
    expect(vi.mocked(f.providers[0].prepare!).mock.calls[0][0].repository.ref).toBe('main');
    expect(f.providers[0].checkout).toHaveBeenCalledWith({ workspaceId: 'alpha-handle', branch: 'feat/task-qa', ref: 'feat/task' }, expect.anything());
    expect(f.agent.createExecution).toHaveBeenCalledWith(expect.objectContaining({ worktreePath: join(f.root, 'alpha') }));
    expect(f.bundle.changes.create).toHaveBeenCalledWith(expect.objectContaining({ sourceBranch: 'feat/task-qa' }));
    expect(vi.mocked(f.providers[0].prepare!).mock.calls[0][0].runId).toBe(vi.mocked(f.runtimeManager.start).mock.calls[0][0].runId);
  });
  it('rejects conflicting implementation refs before acquiring a Provider lease or allocating', async () => {
    const f = await fixture('qa');
    f.repository.workingBranch = 'feat/other-task';
    expect(await f.run()).toMatchObject({ success: false });
    expect(f.events).not.toContain('alpha:lease');
    expect(f.providers[0].prepare).not.toHaveBeenCalled();
    expect(f.branches.mergeFeatureIntoBaseline).not.toHaveBeenCalled();
    expect(f.fallback.prepare).not.toHaveBeenCalled();
  });
});

describe('D04 source branch selection', () => {
  it('creates the implementation branch from the manifest source branch', async () => {
    const f = await fixture('workflow');
    f.repository.sourceBranch = 'feat/parent';
    f.controls.sourceCommit = 'c'.repeat(40);
    expect(await f.run()).toMatchObject({ success: true });
    expect(f.providers[0].prepare).toHaveBeenCalledWith(expect.objectContaining({ repository: { url: 'api', ref: 'main' } }), expect.anything());
    expect(f.providers[0].checkout).toHaveBeenCalledWith({ workspaceId: 'alpha-handle', branch: 'feat/task', ref: 'feat/parent' }, expect.anything());
  });
  it('does not refetch the base when no distinct implementation source is required', async () => {
    const f = await fixture('workflow');
    expect(await f.run()).toMatchObject({ success: true });
    expect(f.providers[0].checkout).toHaveBeenCalledWith({ workspaceId: 'alpha-handle', branch: 'feat/task' }, expect.anything());
  });
  it('accepts the actual pinned implementation revision for isolated QA', async () => {
    const f = await fixture('qa');
    f.controls.sourceCommit = 'c'.repeat(40);
    expect(await f.run()).toMatchObject({ success: true });
    expect(f.providers[0].prepare).toHaveBeenCalledWith(expect.objectContaining({ repository: { url: 'api', ref: 'main' } }), expect.anything());
    expect(f.providers[0].checkout).toHaveBeenCalledWith({ workspaceId: 'alpha-handle', branch: 'feat/task-qa', ref: 'feat/task' }, expect.anything());
  });
});
