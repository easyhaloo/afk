import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWorkItemExecution, replayRun } from '@afk/application';
import { executeWorkItem, reconcileWorkItemMerge, type ExecuteWorkItemDependencies } from './execute-work-item';
import { encodeWorkItemIdForPath, type BacklogItem } from '../../domain/backlog';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store';
import { RunObserver } from '../../observability/run-observer';
import { createExecutionQueryPorts } from '../../observability/query-service';

const workItemId = 'github:acme/api#42';
const item: BacklogItem = {
  id: '42', workItemId: workItemId as BacklogItem['workItemId'], issueNumber: 42,
  project: { platform: 'github', projectKey: 'acme/api', name: 'api' },
  managed: true, executionEligible: true, title: 'Implement', dependsOn: [],
  state: 'ready', executionMode: 'afk', tags: [], branchName: 'afk/42', providerRef: workItemId,
};
let directory: string;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

async function setup(overrides: Partial<BacklogItem> = {}) {
  directory = await mkdtemp(join(tmpdir(), 'afk-execute-'));
  const current = { ...item, ...overrides };
  const get = vi.fn(async (id: string) => id === '42' ? current : { ...item, id, state: 'done' as const });
  const isRunnable = vi.fn(async () => true);
  const run = vi.fn(async () => { current.state = 'verification'; return { success: true }; });
  const process = vi.fn(async () => { current.state = 'merge_ready'; return { success: true, autoMerged: false, mrUrl: 'https://github.com/acme/api/pull/5' }; });
  const changes = {
    findForBacklog: vi.fn(async () => current.state === 'merge_ready' || current.state === 'done' ? {
      id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open',
    } : null),
    verifyIssueAssociation: vi.fn(async () => undefined),
  };
  const deps: ExecuteWorkItemDependencies = {
    lookupWorkItem: vi.fn(async () => ({ ...current, id: workItemId, issueNumber: 42 } as any)),
    readManifest: vi.fn(async () => ({
      workItemId, providerBacklogId: '42', tracker: { platform: 'github', projectKey: 'acme/api' },
      workspaceRoot: directory, manifestPath: join(directory, 'manifest.json'),
    } as any)),
    createContext: vi.fn(async () => ({
      providers: { backlog: { get, isRunnable, setExecutionMode: vi.fn(async () => undefined) } as any, branches: {} as any, changes: changes as any },
      request: { backlogId: '42', workspaceRoot: directory, repoRoot: directory, agentRuntime: { kind: 'default' } } as any,
    })),
    createImplementation: vi.fn(() => ({ run }) as any),
    createQA: vi.fn(() => ({ process }) as any),
    recordAudit: vi.fn(async () => undefined),
  };
  return { deps, get, isRunnable, run, process, changes, current, directory };
}

const input = { workItemId, executionId: 'attempt-1', manifestPath: '/manifest.json', template: 'implement' };

async function seedLock(directory: string, owner: unknown): Promise<string> {
  const lockDirectory = join(directory, '.afk', 'executions');
  await mkdir(lockDirectory, { recursive: true });
  const lockPath = join(lockDirectory, `${encodeWorkItemIdForPath(workItemId as NonNullable<BacklogItem['workItemId']>)}.lock`);
  await writeFile(lockPath, JSON.stringify(owner));
  return lockPath;
}

const priorOwner = {
  version: 1, pid: 7319, host: 'test-host', processStart: 'start-of-prior-process',
  workItemId, executionId: 'old-attempt', nonce: '7f8f23da-e9c0-4f8a-80e4-c821134314a7',
};

function lockProbe(status: 'alive' | 'dead' | 'unknown', pid = 8420) {
  return {
    identity: vi.fn(async () => ({ pid, host: 'test-host', processStart: 'start-of-this-process' })),
    status: vi.fn(async () => status),
  };
}

describe('executeWorkItem', () => {
  it('loads the default execution through application ports without an injected loader', async () => {
    const { deps, directory } = await setup();
    const previous = process.env.AFK_EVENT_STORE_DIR;
    process.env.AFK_EVENT_STORE_DIR = join(directory, 'events');
    try {
      await expect(reconcileWorkItemMerge(input, deps)).rejects.toThrow('execution audit identity or integrity mismatch');
    } finally {
      if (previous === undefined) delete process.env.AFK_EVENT_STORE_DIR;
      else process.env.AFK_EVENT_STORE_DIR = previous;
    }
  });

  it('reconciles a root PR only after provider-confirmed merge, without duplicate terminal events', async () => {
    const { deps, changes, current, directory } = await setup();
    const observer = new RunObserver({ events: new JsonlEventStore({ root: join(directory, 'events') }) });
    deps.recordAudit = (context, data) => observer.record(context, data);
    deps.loadExecution = runId => loadWorkItemExecution(runId, createExecutionQueryPorts(new JsonlEventStore({ root: join(directory, 'events') })));
    const context = await deps.createContext!({} as any, input, {} as any);
    context.request.targetBranch = 'main';
    context.providers.backlog.transition = vi.fn(async (_id, state) => { current.state = state; });
    deps.createContext = vi.fn(async () => context);
    changes.get = vi.fn(async () => ({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open', sourceBranch: 'afk/42-qa', targetBranch: 'main' }));
    expect((await executeWorkItem(input, deps)).status).toBe('merge_ready');
    current.workItemId = undefined;
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'merge_ready' });
    expect(context.providers.backlog.transition).not.toHaveBeenCalled();
    changes.get.mockResolvedValue({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged', sourceBranch: 'afk/42-qa', targetBranch: 'main' });
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'done' });
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'done' });
    const result = await deps.loadExecution('attempt-1');
    expect(result.summary).toMatchObject({ status: 'done', pr: { state: 'merged' } });
    expect(result.timeline.events.filter(event => event.data.kind === 'change.merge_verified')).toHaveLength(1);
    expect(context.providers.backlog.transition).toHaveBeenCalledWith('42', 'done', { changeId: '5' });
  });

  it('rejects a different or unlinked PR during root reconciliation', async () => {
    const { deps, changes, directory } = await setup();
    const observer = new RunObserver({ events: new JsonlEventStore({ root: join(directory, 'events') }) });
    deps.recordAudit = (context, data) => observer.record(context, data);
    deps.loadExecution = runId => loadWorkItemExecution(runId, createExecutionQueryPorts(new JsonlEventStore({ root: join(directory, 'events') })));
    const context = await deps.createContext!({} as any, input, {} as any);
    context.request.targetBranch = 'main';
    context.providers.backlog.transition = vi.fn();
    deps.createContext = vi.fn(async () => context);
    await executeWorkItem(input, deps);
    changes.get = vi.fn(async () => ({ id: '5', url: 'https://github.com/acme/api/pull/other', state: 'merged', sourceBranch: 'afk/42-qa', targetBranch: 'main' }));
    await expect(reconcileWorkItemMerge(input, deps)).rejects.toThrow(/identity/);
    changes.get.mockResolvedValue({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged', sourceBranch: 'afk/42-qa', targetBranch: 'main' });
    changes.verifyIssueAssociation.mockRejectedValueOnce(new Error('not linked'));
    await expect(reconcileWorkItemMerge(input, deps)).rejects.toThrow('not linked');
    expect(context.providers.backlog.transition).not.toHaveBeenCalled();
    expect((await deps.loadExecution('attempt-1')).summary.status).toBe('awaiting_merge');
  });

  it('keeps the audit awaiting merge if recording fails and can safely retry', async () => {
    const { deps, changes, current, directory } = await setup();
    const observer = new RunObserver({ events: new JsonlEventStore({ root: join(directory, 'events') }) });
    deps.recordAudit = (context, data) => observer.record(context, data);
    deps.loadExecution = runId => loadWorkItemExecution(runId, createExecutionQueryPorts(new JsonlEventStore({ root: join(directory, 'events') })));
    const context = await deps.createContext!({} as any, input, {} as any);
    context.request.targetBranch = 'main';
    context.providers.backlog.transition = vi.fn(async (_id, state) => { current.state = state; });
    deps.createContext = vi.fn(async () => context);
    await executeWorkItem(input, deps);
    changes.get = vi.fn(async () => ({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged', sourceBranch: 'afk/42-qa', targetBranch: 'main' }));
    deps.recordAudit = vi.fn(async () => { throw new Error('audit unavailable'); });
    await expect(reconcileWorkItemMerge(input, deps)).rejects.toThrow('audit unavailable');
    expect((await deps.loadExecution('attempt-1')).summary.status).toBe('awaiting_merge');
    deps.recordAudit = (auditContext, data) => observer.record(auditContext, data);
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'done' });
  });

  it('recovers a published root PR when the process stops before the publication audit append', async () => {
    const { deps, changes, current, directory } = await setup();
    current.state = 'merge_ready';
    const observer = new RunObserver({ events: new JsonlEventStore({ root: join(directory, 'events') }) });
    deps.recordAudit = (context, data) => observer.record(context, data);
    deps.loadExecution = runId => loadWorkItemExecution(runId, createExecutionQueryPorts(new JsonlEventStore({ root: join(directory, 'events') })));
    const context = await deps.createContext!({} as any, input, {} as any);
    context.request.targetBranch = 'main';
    context.providers.backlog.transition = vi.fn(async (_id, state) => { current.state = state; });
    deps.createContext = vi.fn(async () => context);
    await observer.record({ traceId: 'attempt-1', runId: 'attempt-1', workItemId, profileId: 'test', attempt: 1, actor: { kind: 'system', id: 'qa' } }, { kind: 'qa.passed' });
    changes.get = vi.fn(async () => ({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged', sourceBranch: 'afk/42-qa', targetBranch: 'main' }));
    const journalDirectory = join(directory, '.afk', 'executions');
    await mkdir(journalDirectory, { recursive: true });
    await expect(reconcileWorkItemMerge(input, deps)).rejects.toThrow(/awaiting a verified root PR merge/);
    await writeFile(join(journalDirectory, 'attempt-1.jsonl'), JSON.stringify({ executionId: 'attempt-1', workItemId,
      phase: 'published', changeId: '5', changeUrl: 'https://github.com/acme/api/pull/5' }) + '\n');
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'done' });
    expect((await deps.loadExecution('attempt-1')).summary).toMatchObject({ status: 'done', pr: { id: '5', state: 'merged' } });
  });

  it('recovers publication after the intent journal but before PR identity and backlog state were recorded', async () => {
    const { deps, changes, current, directory } = await setup();
    current.state = 'verification';
    const observer = new RunObserver({ events: new JsonlEventStore({ root: join(directory, 'events') }) });
    deps.recordAudit = (context, data) => observer.record(context, data);
    deps.loadExecution = runId => loadWorkItemExecution(runId, createExecutionQueryPorts(new JsonlEventStore({ root: join(directory, 'events') })));
    const context = await deps.createContext!({} as any, input, {} as any);
    context.request.targetBranch = 'main';
    context.providers.backlog.transition = vi.fn(async (_id, state) => { current.state = state; });
    context.providers.backlog.setExecutionMode = vi.fn();
    deps.createContext = vi.fn(async () => context);
    await observer.record({ traceId: 'attempt-1', runId: 'attempt-1', workItemId, profileId: 'test', attempt: 1, actor: { kind: 'system', id: 'qa' } }, { kind: 'qa.passed' });
    const change = { id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open' as const, sourceBranch: 'afk/42-qa', targetBranch: 'main' };
    changes.findForBacklog.mockResolvedValue(change);
    changes.get = vi.fn(async () => change);
    const journalDirectory = join(directory, '.afk', 'executions');
    await mkdir(journalDirectory, { recursive: true });
    await expect(reconcileWorkItemMerge(input, deps)).rejects.toThrow(/awaiting a verified root PR merge/);
    await writeFile(join(journalDirectory, 'attempt-1.jsonl'), JSON.stringify({ executionId: 'attempt-1', workItemId, phase: 'publication_requested' }) + '\n');
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'merge_ready', changeUrl: change.url });
    expect(context.providers.backlog.transition).toHaveBeenCalledWith('42', 'merge_ready', { changeId: '5' });
    expect(context.providers.backlog.setExecutionMode).toHaveBeenCalledWith('42', 'hitl');
    expect((await deps.loadExecution('attempt-1')).summary.status).toBe('awaiting_merge');
  });

  it('writes implementation, independent QA, and the confirmed PR to one replayable execution stream', async () => {
    const { deps, run, current, directory } = await setup();
    const store = new JsonlEventStore({ root: join(directory, 'events') });
    const observer = new RunObserver({ events: store });
    deps.recordAudit = (context, data) => observer.record(context, data);
    run.mockImplementation(async (options: { observationRunId: string; observationWorkItemId: string }) => {
      const context = { traceId: options.observationRunId, runId: options.observationRunId,
        workItemId: options.observationWorkItemId, profileId: 'test', attempt: 1,
        actor: { kind: 'system' as const, id: 'implementation' } };
      await observer.record(context, { kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId,
        profileId: context.profileId, attempt: 1, status: 'pending' } });
      await observer.record(context, { kind: 'run.started' });
      await observer.record(context, { kind: 'implementation.completed' });
      current.state = 'verification';
      return { success: true };
    });
    await expect(executeWorkItem(input, deps)).resolves.toMatchObject({ status: 'merge_ready' });
    const queried = await loadWorkItemExecution('attempt-1', createExecutionQueryPorts(store));
    expect(queried.timeline.integrity.lastSequence).toBe(7);
    expect(queried.summary).toMatchObject({ workItemId, status: 'awaiting_merge', pr: { id: '5', url: 'https://github.com/acme/api/pull/5' } });
    expect(queried.timeline.events.map(event => event.data.kind)).toEqual([
      'run.requested', 'run.started', 'implementation.completed', 'qa.started', 'qa.passed', 'change.published', 'human_gate.opened',
    ]);
    expect((await replayRun('attempt-1', store)).state).toMatchObject({ run: { status: 'awaiting_human' }, terminal: false });
  });

  it('records intent, claims through WorkflowRunner once, verifies independently, and only then succeeds', async () => {
    const { deps, run, process, changes, directory } = await setup();
    const result = await executeWorkItem(input, deps);
    expect(result).toMatchObject({ status: 'merge_ready', changeUrl: 'https://github.com/acme/api/pull/5' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ backlogId: '42', session: 'attempt-1', template: 'implement', executionMode: 'batch',
      observationRunId: 'attempt-1', observationWorkItemId: workItemId, auditRequired: true }));
    expect(process).toHaveBeenCalledWith('42');
    expect(changes.verifyIssueAssociation).toHaveBeenCalledWith(expect.objectContaining({ id: '5' }), workItemId);
    expect(vi.mocked(deps.recordAudit!).mock.calls.map(([, event]) => event.kind)).toEqual(['qa.started', 'qa.passed', 'change.published', 'human_gate.opened']);
    expect(vi.mocked(deps.recordAudit!).mock.calls.every(([context]) => context.runId === 'attempt-1' && context.workItemId === workItemId)).toBe(true);
    const events = (await readFile(join(directory, '.afk', 'executions', 'attempt-1.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    expect(events.map(event => event.phase)).toEqual(['requested', 'implementing', 'verifying', 'merge_ready']);
    expect(events.every(event => event.executionId === 'attempt-1' && event.workItemId === workItemId)).toBe(true);
  });

  it.each([
    [{ managed: false }, /unmanaged/],
    [{ executionEligible: false }, /ineligible/],
    [{ executionMode: 'hitl' as const }, /hitl/],
    [{ state: 'verification' as const }, /ready or rework/],
    [{ providerRef: 'github:other/api#42' }, /identity/],
    [{ dependsOn: ['41'] }, /dependenc/],
  ])('rejects invalid candidate %j without starting implementation', async (override, message) => {
    const { deps, run } = await setup(override);
    if ('dependsOn' in override) {
      const context = await deps.createContext!({} as any, input, {} as any);
      context.providers.backlog.get = vi.fn(async (id: string) => id === '42' ? { ...item, ...override } : { ...item, state: 'ready' });
      deps.createContext = vi.fn(async () => context);
    }
    await expect(executeWorkItem(input, deps)).rejects.toThrow(message);
    expect(run).not.toHaveBeenCalled();
  });

  it('does not run QA on implementation failure or lost claim', async () => {
    const { deps, run, process } = await setup();
    run.mockResolvedValueOnce({ success: false } as any).mockResolvedValueOnce({ success: false, skipped: 'not_claimed' } as any);
    expect((await executeWorkItem(input, deps)).status).toBe('blocked');
    expect((await executeWorkItem({ ...input, executionId: 'attempt-2' }, deps)).status).toBe('not_claimed');
    expect(process).not.toHaveBeenCalled();
  });

  it('returns non-success for QA rework or publication failure', async () => {
    const { deps, process } = await setup();
    process.mockResolvedValueOnce({ success: false, rework: true } as any);
    expect((await executeWorkItem(input, deps)).status).toBe('rework');
    expect(vi.mocked(deps.recordAudit!).mock.calls.map(([, event]) => event.kind)).toEqual(['qa.started', 'qa.failed', 'run.finished']);
    const { deps: nextDeps, process: nextProcess } = await setup();
    nextProcess.mockResolvedValueOnce({ success: false } as any);
    expect((await executeWorkItem({ ...input, executionId: 'attempt-2' }, nextDeps)).status).toBe('blocked');
  });

  it('requires provider confirmation and terminal provider state for success', async () => {
    const { deps, changes } = await setup();
    changes.findForBacklog.mockResolvedValue(null);
    expect((await executeWorkItem(input, deps)).status).toBe('blocked');
    expect(vi.mocked(deps.recordAudit!).mock.calls.some(([, event]) => event.kind === 'change.published')).toBe(false);
  });

  it('does not publish a success event when the provider cannot verify the exact Issue association', async () => {
    const { deps, changes } = await setup();
    changes.verifyIssueAssociation.mockRejectedValueOnce(new Error('not linked to issue'));
    await expect(executeWorkItem(input, deps)).rejects.toThrow('not linked to issue');
    expect(vi.mocked(deps.recordAudit!).mock.calls.some(([, event]) => event.kind === 'change.published')).toBe(false);
    expect(vi.mocked(deps.recordAudit!).mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'run.finished', outcome: 'failed' });
  });

  it('does not run QA if its start event cannot be persisted', async () => {
    const { deps, process } = await setup();
    deps.recordAudit = vi.fn(async () => { throw new Error('audit unavailable'); });
    await expect(executeWorkItem(input, deps)).rejects.toThrow('audit unavailable');
    expect(process).not.toHaveBeenCalled();
  });

  it('records an audit failure if verification state cannot be read after implementation', async () => {
    const { deps, process, get } = await setup();
    get.mockResolvedValueOnce(item).mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(executeWorkItem(input, deps)).rejects.toThrow('provider unavailable');
    expect(process).not.toHaveBeenCalled();
    expect(vi.mocked(deps.recordAudit!).mock.calls.map(([, event]) => event.kind)).toEqual(['run.finished']);
  });

  it('recognizes an eligible child only after its change is merged', async () => {
    const { deps, current, process, changes } = await setup({ parentId: '41' });
    process.mockImplementationOnce(async () => {
      current.state = 'done';
      return { success: true, autoMerged: true, mrUrl: 'https://github.com/acme/api/pull/5' };
    });
    changes.findForBacklog.mockImplementation(async () => current.state === 'done'
      ? { id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged' } : null);
    expect((await executeWorkItem(input, deps)).status).toBe('done');
  });

  it('does not start a runner when attempt journaling is unavailable', async () => {
    const { deps, run, directory } = await setup();
    const journalDirectory = join(directory, '.afk', 'executions');
    await mkdir(journalDirectory, { recursive: true });
    await writeFile(join(journalDirectory, 'attempt-1.jsonl'), 'existing attempt');
    await expect(executeWorkItem(input, deps)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('reports an existing open PR rather than starting a duplicate attempt', async () => {
    const { deps, run, changes } = await setup();
    changes.findForBacklog.mockResolvedValue({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open' });
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/already has an open change request/);
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects a concurrent attempt before spawning another runner', async () => {
    const { deps, run } = await setup();
    let finish!: (value: { success: boolean }) => void;
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = executeWorkItem(input, deps);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await expect(executeWorkItem({ ...input, executionId: 'attempt-2' }, deps)).rejects.toThrow(/active attempt/);
    finish({ success: false });
    await first;
  });

  it('never steals an existing lock while its PID is alive, even if its start identity differs', async () => {
    const { deps, directory, run } = await setup();
    const lockPath = await seedLock(directory, priorOwner);
    const probe = lockProbe('alive', priorOwner.pid);
    deps.lockProbe = probe;
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/active attempt/);
    expect(probe.status).toHaveBeenCalledWith(priorOwner.pid);
    expect(await readFile(lockPath, 'utf8')).toBe(JSON.stringify(priorOwner));
    expect(run).not.toHaveBeenCalled();
  });

  it('reclaims a stale lock after verifying that its PID belongs to a different process start', async () => {
    const { deps, directory, run } = await setup();
    await seedLock(directory, priorOwner);
    deps.lockProbe = {
      ...lockProbe('alive', priorOwner.pid),
      start: vi.fn(async () => 'a-reused-process-start'),
    };
    run.mockResolvedValue({ success: false });
    await expect(executeWorkItem(input, deps)).resolves.toMatchObject({ status: 'blocked' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('does not let two stale-lock reclaimers start the same work item', async () => {
    const { deps, directory, run } = await setup();
    await seedLock(directory, priorOwner);
    deps.lockProbe = {
      identity: async () => ({ pid: 8420, host: 'test-host', processStart: 'start-of-this-process' }),
      status: async (pid: number) => pid === priorOwner.pid ? 'dead' : 'alive',
    };
    let finish!: (value: { success: boolean }) => void;
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = executeWorkItem(input, deps);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const lockPath = join(directory, '.afk', 'executions', `${encodeWorkItemIdForPath(workItemId as NonNullable<BacklogItem['workItemId']>)}.lock`);
    const newOwner = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(newOwner).toMatchObject({ pid: 8420, processStart: 'start-of-this-process', executionId: 'attempt-1' });
    await expect(executeWorkItem({ ...input, executionId: 'attempt-2' }, deps)).rejects.toThrow(/active attempt/);
    expect(run).toHaveBeenCalledTimes(1);
    finish({ success: false });
    await first;
  });

  it('does not remove a replacement lock during release', async () => {
    const { deps, directory, run } = await setup();
    deps.lockProbe = lockProbe('alive');
    let finish!: (value: { success: boolean }) => void;
    run.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = executeWorkItem(input, deps);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    const lockPath = join(directory, '.afk', 'executions', `${encodeWorkItemIdForPath(workItemId as NonNullable<BacklogItem['workItemId']>)}.lock`);
    await rm(lockPath);
    await writeFile(lockPath, JSON.stringify(priorOwner));
    finish({ success: false });
    await first;
    expect(await readFile(lockPath, 'utf8')).toBe(JSON.stringify(priorOwner));
  });

  it('recovers a verified dead owner by quarantining the old lock before running', async () => {
    const { deps, directory, run } = await setup();
    const lockPath = await seedLock(directory, priorOwner);
    deps.lockProbe = lockProbe('dead');
    expect((await executeWorkItem(input, deps)).status).toBe('merge_ready');
    expect(run).toHaveBeenCalledTimes(1);
    const files = await readdir(join(directory, '.afk', 'executions'));
    const quarantined = files.filter(name => name.includes('.lock.stale-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(directory, '.afk', 'executions', quarantined[0]), 'utf8')).toBe(JSON.stringify(priorOwner));
    await expect(readFile(lockPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['missing start identity', { ...priorOwner, processStart: undefined }, 'dead'],
    ['wrong host', { ...priorOwner, host: 'other-host' }, 'dead'],
    ['wrong work item', { ...priorOwner, workItemId: 'github:acme/api#77' }, 'dead'],
    ['unknown process state', priorOwner, 'unknown'],
    ['old empty lock', '', 'dead'],
  ] as const)('rejects %s without removing the lock', async (_reason, owner, status) => {
    const { deps, directory, run } = await setup();
    const lockPath = await seedLock(directory, owner);
    deps.lockProbe = lockProbe(status);
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/cannot verify|active attempt/);
    expect(await readFile(lockPath, 'utf8')).toBe(JSON.stringify(owner));
    expect((await readdir(join(directory, '.afk', 'executions'))).some(name => name.endsWith('.recovery'))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed when its own process identity cannot be established', async () => {
    const { deps, directory, run } = await setup();
    deps.lockProbe = { identity: async () => undefined, status: async () => 'dead' };
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/identity/);
    expect(await readdir(join(directory, '.afk', 'executions'))).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
