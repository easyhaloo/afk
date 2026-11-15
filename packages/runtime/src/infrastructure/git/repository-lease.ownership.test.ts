import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { FilesystemClaimLock } from '../../domain/backlog/claim.js';
import { RepositoryLeases, repositoryClaimIds, repositoryLeaseKey } from './repository-lease.js';
import { executeWorkItem, type ExecuteWorkItemDependencies } from '../../application/workflows/execute-work-item.js';
import { prepareManagedRepositories, selectManagedRepository } from '../../application/plugins/repository-lifecycle.js';
import { PluginRuntime, type Plugin } from '../../application/plugins/runtime.js';
import { RunResourceScope } from '../../application/workflows/resource-scope.js';
import type { BacklogItem } from '../../domain/backlog/index.js';
import type { WorkflowRunRepository } from '../../application/workflows/run-request.js';
import type { RepositoryProvider, RepositoryWorkspace } from '../../plugin-sdk/capabilities.js';

vi.mock('simple-git', async original => ({ ...await original<typeof import('simple-git')>(), simpleGit: vi.fn(() => ({
  revparse: vi.fn(async (args: string[]) => args.includes('--abbrev-ref') ? 'feat/task' : 'a'.repeat(40)),
})) }));
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function directory() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'afk-lease-ownership-')));
  roots.push(root);
  return root;
}

describe('RepositoryLeases ordinary parent and child ownership', () => {
  it('serializes concurrent final release and retries an ordinary claim release failure', async () => {
    const manager = new RepositoryLeases(await directory());
    const acquire = FilesystemClaimLock.prototype.acquire;
    let attempts = 0;
    vi.spyOn(FilesystemClaimLock.prototype, 'acquire').mockImplementation(async function (this: FilesystemClaimLock, request) {
      const claim = await acquire.call(this, request);
      if (!claim) return claim;
      return { ...claim, release: async () => { attempts++; if (attempts === 1) throw new Error('ordinary release EIO'); await claim.release(); } };
    });
    const handle = await manager.acquire(['github:fixture/api']);
    await expect(handle.release()).rejects.toThrow('ordinary release EIO');
    expect(await manager.active(['github:fixture/api'])).toBe(true);
    await Promise.all([handle.release(), handle.release()]);
    expect(attempts).toBe(2);
    expect(await manager.active(['github:fixture/api'])).toBe(false);
    await expect(handle.heartbeat()).rejects.toThrow('released');
  });
  it('does not reacquire through a stale parent async context after physical release', async () => {
    const manager = new RepositoryLeases(await directory());
    let invoke!: ReturnType<typeof AsyncLocalStorage.snapshot>;
    await manager.run(['github:fixture/api'], async () => { invoke = AsyncLocalStorage.snapshot(); });
    await expect(invoke(() => manager.acquire(['github:fixture/api']))).rejects.toThrow('released');
  });

  it('keeps an inherited canonical claim until its final sibling releases, with idempotent releases', async () => {
    const manager = new RepositoryLeases(await directory());
    const key = 'github:fixture/api';
    let first!: Awaited<ReturnType<RepositoryLeases['acquire']>>;
    let second!: typeof first;
    let ids: string[] = [];
    await manager.run([key], async () => {
      ids = repositoryClaimIds();
      first = await manager.acquire([key]);
      second = await manager.acquire([key]);
      expect(first.claimIds).toEqual(ids);
      expect(second.claimIds).toEqual(ids);
    });
    try {
      expect(await manager.active([key])).toBe(true);
      await expect(manager.acquire([key])).rejects.toThrow('leased');
      await first.heartbeat();
      await first.release();
      await first.release();
      expect(await manager.active([key])).toBe(true);
      await second.heartbeat();
      await second.release();
      expect(await manager.active([key])).toBe(false);
      const next = await manager.acquire([key]);
      expect(next.claimIds).not.toEqual(ids);
      await next.release();
    } finally { await first.release(); await second.release(); }
  });

  it.each([false, true])('owns the actual executeWorkItem canonical lease across retained cleanup=%s', async retained => {
    const root = await directory();
    vi.stubEnv('AFK_STATE_DIR', join(root, 'state'));
    const manager = new RepositoryLeases();
    const key = 'github:fixture/api';
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const acquire = FilesystemClaimLock.prototype.acquire;
    const canonicalHeartbeat = vi.fn(async () => {});
    vi.spyOn(FilesystemClaimLock.prototype, 'acquire').mockImplementation(async function (this: FilesystemClaimLock, request) {
      const claim = await acquire.call(this, request);
      if (!claim || request.key !== repositoryLeaseKey(key)) return claim;
      canonicalHeartbeat.mockImplementation(claim.heartbeat);
      return { ...claim, heartbeat: canonicalHeartbeat };
    });
    const workItemId = key + '#42';
    const repository: WorkflowRunRepository = { platform: 'github', projectKey: 'fixture/api', name: 'api', checkoutPath: 'repositories/api', repoRoot: join(root, 'default'), baseBranch: 'main', workingBranch: 'feat/task', primary: true };
    const item: BacklogItem = { id: workItemId, workItemId: workItemId as BacklogItem['workItemId'], providerRef: workItemId, issueNumber: 42,
      project: { platform: 'github', projectKey: 'fixture/api', name: 'api' }, managed: true, executionEligible: true,
      title: 'Own selected allocation', dependsOn: [], tags: [], state: 'ready', executionMode: 'afk', branchName: 'feat/task' };
    const path = join(root, 'selected');
    await mkdir(path);
    const commit = 'a'.repeat(40);
    let cleanupAllowed = !retained;
    let childIds: string[] = [];
    let parentIds: string[] = [];
    let scope!: RunResourceScope;
    let owned: RepositoryWorkspace | undefined;
    const events: string[] = [];
    const provider: RepositoryProvider = { id: 'ordinary', capabilities: { read: true, clone: true, push: true, prepare: true, checkout: true, publish: true, cleanup: true },
      snapshot: vi.fn(async () => ({ commit, branch: 'feat/task', dirty: false })),
      withLifecycleLease: async (_request, operation) => new RepositoryLeases().run([key], async () => {
        childIds = repositoryClaimIds();
        events.push('child-entered');
        try { return await operation(); } finally { events.push('child-exited'); }
      }),
      prepare: vi.fn(async request => owned = { id: 'ordinary-allocation', runId: request.runId, repository: request.repository, path, snapshot: { commit, branch: 'main', dirty: false } }),
      checkout: vi.fn(async () => ({ ...owned!, snapshot: { commit, branch: 'feat/task', dirty: false } })),
      publish: vi.fn(async () => ({ commit, branch: 'feat/task' })),
      cleanup: vi.fn(async () => ({ removed: cleanupAllowed })),
    };
    const runtime = new PluginRuntime();
    const integration: Plugin = { manifest: { id: 'workflow.integrations', version: '1.0.0', apiVersion: 1, provides: [], trusted: true }, activate() {} };
    await runtime.activate(integration);
    await runtime.activate({ id: 'fixture.repository', version: '1.0.0', setup(context) { context.registerRepositoryProvider('ordinary', provider); } });
    selectManagedRepository(runtime, 'ordinary', integration);
    const fallback = { prepare: vi.fn(async () => { throw new Error('unselected fallback'); }) };
    const dependencies: ExecuteWorkItemDependencies = {
      plugins: runtime,
      readManifest: async () => ({ workItemId, providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'fixture/api' }, workspaceRoot: root, manifestPath: join(root, 'manifest.json'), repositories: [repository] }) as never,
      lookupWorkItem: async () => ({ ...item, id: workItemId, issueNumber: 42 }) as never,
      createContext: async () => ({ providers: { backlog: { get: async () => item, isRunnable: async () => true }, changes: { findForBacklog: async () => null } },
        request: { backlogId: '42', workspaceRoot: root, repoRoot: root, agentRuntime: { kind: 'default' } } }) as never,
      createImplementation: () => ({ run: async request => {
        parentIds = repositoryClaimIds();
        scope = new RunResourceScope({ repoRoot: root, baseBranch: 'main', managePrimary: false,
          ownership: { workspaceRoot: root, repositories: [repository], owner: request.observationRunId! } });
        await scope.acquireOwnership();
        await prepareManagedRepositories({ runtime, fallback, repositories: [repository], workspaceRoot: root, scope, runId: request.observationRunId! });
        try { await scope.finish({ status: 'success' }); }
        catch (error) { throw new AggregateError([error], 'cleanup ownership unconfirmed', { cause: { recovery: { scope } } }); }
        return { success: false };
      } }),
      recordAudit: async () => undefined,
      lockProbe: { identity: async () => ({ pid: process.pid, host: 'ordinary-test', processStart: 'owned-start' }), status: async () => 'alive' },
    };
    try {
      const result = await executeWorkItem({ workItemId, executionId: 'actual-parent-run', manifestPath: join(root, 'manifest.json'), runOptions: { executionMode: 'batch' } }, dependencies).catch(error => error as AggregateError);
      expect(owned?.runId).toBe('actual-parent-run');
      expect(childIds).toEqual(parentIds);
      expect(parentIds).toHaveLength(1);
      expect(fallback.prepare).not.toHaveBeenCalled();
      if (retained) {
        expect(result).toBeInstanceOf(AggregateError);
        expect(events).not.toContain('child-exited');
        expect(await manager.active([key])).toBe(true);
        const heartbeats = canonicalHeartbeat.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(canonicalHeartbeat.mock.calls.length).toBeGreaterThan(heartbeats);
        await expect(manager.acquire([key])).rejects.toThrow('leased');
        const before = await manager.active([key]);
        await expect(scope.finish({ status: 'failed' })).rejects.toThrow('refused');
        expect(await manager.active([key])).toBe(before);
        cleanupAllowed = true;
        await scope.finish({ status: 'failed' });
      } else expect(result).toMatchObject({ status: 'blocked' });
      expect(events).toContain('child-exited');
      expect(await manager.active([key])).toBe(false);
      const next = await manager.acquire([key]);
      expect(next.claimIds).not.toEqual(parentIds);
      await next.release();
    } finally { cleanupAllowed = true; await scope?.finish({ status: 'failed' }).catch(() => undefined); await runtime.dispose(); }
  });
});

async function manager() { const root = await mkdtemp(join(tmpdir(), 'quality-ordinary-')); roots.push(root); return new RepositoryLeases(root); }
const key = 'github:quality/ordinary';
it('rejects a late parent continuation after its own reference is released while a child remains live', async () => {
  const leases = await manager();
  let child!: Awaited<ReturnType<RepositoryLeases['acquire']>>;
  let late!: Promise<Awaited<ReturnType<RepositoryLeases['acquire']>>>;
  let acquired: typeof child | undefined;
  let resume!: () => void;
  const gate = new Promise<void>(resolve => { resume = resolve; });
  await leases.run([key], async () => {
    child = await leases.acquire([key]);
    late = (async () => { await gate; return leases.acquire([key]); })();
  });
  expect(await leases.active([key])).toBe(true);
  await expect(leases.acquire([key])).rejects.toThrow('leased');
  resume();
  const outcome = await late.then(handle => { acquired = handle; return { status: 'fulfilled', claimIds: handle.claimIds }; }, error => ({ status: 'rejected', error: String(error) }));
  try {
    await child.release();
    const retainedAfterChildRelease = await leases.active([key]);
    await writeFile(join(process.env.QUALITY_OUTPUT!, 'late-parent-evidence.json'), JSON.stringify({ outcome, childClaimIds: child.claimIds, retainedAfterChildRelease }, null, 2));
    expect(outcome.status).toBe('rejected');
    expect(retainedAfterChildRelease).toBe(false);
  } finally { await acquired?.release(); await child.release(); }
});
it('allows the genuinely live child to retain a nested phase after parent return', async () => {
  const leases = await manager();
  let enter!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const gate = new Promise<void>(resolve => { resume = resolve; });
  let child!: Promise<void>;
  await leases.run([key], async () => {
    child = leases.run([key], async () => {
      enter(); await gate;
      const nested = await leases.acquire([key]);
      try { expect(await leases.active([key])).toBe(true); } finally { await nested.release(); }
    });
    await entered;
  });
  expect(await leases.active([key])).toBe(true);
  resume(); await child;
  expect(await leases.active([key])).toBe(false);
});
it('retries only the remaining physical claim after a partial final release failure', async () => {
  const leases = await manager();
  const acquire = FilesystemClaimLock.prototype.acquire;
  const calls: string[] = [];
  const keys = ['github:quality/a', 'github:quality/b'];
  let attempts = 0;
  vi.spyOn(FilesystemClaimLock.prototype, 'acquire').mockImplementation(async function(this: FilesystemClaimLock, request) {
    const claim = await acquire.call(this, request);
    if (!claim) return claim;
    return { ...claim, release: async () => {
      calls.push(request.key);
      if (++attempts === 2) throw new Error('ordinary final release EIO');
      await claim.release();
    } };
  });
  const handle = await leases.acquire(keys);
  try {
    await expect(handle.release()).rejects.toThrow('EIO');
    expect(calls).toHaveLength(2);
    expect(await leases.active([keys[1]])).toBe(false);
    expect(await leases.active([keys[0]])).toBe(true);
    await Promise.all([handle.release(), handle.release()]);
    expect(calls).toEqual([calls[0], calls[1], calls[1]]);
    expect(await leases.active(keys)).toBe(false);
  } finally { await handle.release(); }
});
