import { workspaceDataDirectory, executionWorkspacePath, executionManifestPath } from '../../infrastructure/workspace.js';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { loadWorkItemExecution, replayRun } from '@afk/application';
import { executeWorkItem, reconcileWorkItemMerge, type ExecuteWorkItemDependencies } from './execute-work-item.js';
import { encodeWorkItemIdForPath, type BacklogItem } from '../../domain/backlog/index.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { getObservationSignal, RunObserver } from '../../observability/run-observer.js';
import { createRunObserver } from '../../infrastructure/observability/run-observer-factory.js';
import { createLocalEncryptedEvidenceStore } from '../../infrastructure/observability/local-evidence-store.js';
import * as workflowConfig from '../../infrastructure/config/manager.js';
import type { EvidenceRecord, EvidenceStoreProvider } from '../../plugin-sdk/capabilities.js';
import { createExecutionQueryPorts } from '../../observability/query-service.js';
import { QARunner } from '../runners/qa-runner.js';
import { getLogContext } from '../../infrastructure/io/index.js';
import { ExperienceContextProvider, experienceStorePath, verifyExperienceRun } from '../learning/runtime.js';
import { ExperienceStore } from '../learning/experience-store.js';
import { PluginRuntime } from '../plugins/runtime.js';
import { WorkflowRunner, type RunnerOptions } from '../workflow-engine.js';
import { TemplateLoader } from '../../domain/templates/loader.js';
import type { ChangeRequest } from '../../infrastructure/tracker/changes/provider.js';

const workItemId = 'github:acme/api#42';
const item: BacklogItem = {
  id: workItemId, workItemId: workItemId as BacklogItem['workItemId'], issueNumber: 42,
  project: { platform: 'github', projectKey: 'acme/api', name: 'api' },
  managed: true, executionEligible: true, title: 'Implement', dependsOn: [],
  state: 'ready', executionMode: 'afk', tags: [], branchName: 'afk/backlog-42', providerRef: workItemId,
};
let directory: string;
afterEach(async () => { vi.unstubAllEnvs(); if (directory) await rm(directory, { recursive: true, force: true }); });

async function setup(overrides: Partial<BacklogItem> = {}) {
  directory = await mkdtemp(join(tmpdir(), 'afk-execute-'));
  const current = { ...item, ...overrides };
  const get = vi.fn(async (id: string) => id === '42' ? current : { ...item, id, state: 'done' as const });
  const isRunnable = vi.fn(async () => true);
  const run = vi.fn<[RunnerOptions], Promise<{ success: boolean }>>(async () => { current.state = 'verification'; return { success: true }; });
  const process = vi.fn(async () => { current.state = 'merge_ready'; return { success: true, mrUrl: 'https://github.com/acme/api/pull/5' }; });
  const changes: {
    get?: Mock<[], Promise<ChangeRequest>>;
    findForBacklog: Mock<[], Promise<Pick<ChangeRequest, 'id' | 'url' | 'state'> | null>>;
    verifyIssueAssociation: Mock<[], Promise<undefined>>;
  } = {
    findForBacklog: vi.fn<[], Promise<Pick<ChangeRequest, 'id' | 'url' | 'state'> | null>>(async () => current.state === 'merge_ready' || current.state === 'done' ? {
      id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open' as const,
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
  const lockDirectory = join(workspaceDataDirectory(directory), 'executions');
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
  it('uses the classified template in the default runner without reloading a changed source', async () => {
    const { deps, process: verify, directory } = await setup();
    vi.stubEnv('HOME', directory);
    vi.stubEnv('AFK_EVENT_STORE_DIR', join(directory, 'events'));
    const template = await new TemplateLoader().load('issue-implementation');
    deps.template = template;
    deps.createImplementation = undefined;
    const loading = vi.spyOn(TemplateLoader.prototype, 'load').mockRejectedValue(new Error('template source changed'));
    const observed = vi.spyOn(WorkflowRunner.prototype as unknown as {
      runObserved: (...args: unknown[]) => Promise<{ success: boolean }>;
    }, 'runObserved').mockImplementation(async (...args) => {
      expect(args[3]).toEqual(template);
      expect(args[3]).not.toBe(template);
      return { success: false };
    });
    try {
      expect(await executeWorkItem(input, deps)).toMatchObject({ status: 'blocked' });
      expect(observed).toHaveBeenCalledOnce();
      expect(loading).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    } finally { observed.mockRestore(); loading.mockRestore(); }
  });
  it('passes managed QA verification evidence to the existing execution audit owner', async () => {
    const { deps, current, directory } = await setup();
    deps.createQA = undefined;
    const store = new JsonlEventStore({ root: join(directory, 'events') });
    const observer = new RunObserver({ events: store });
    deps.recordAudit = (context, data, options) => observer.record(context, data, options);
    const evidence = { uri: `evidence://${'c'.repeat(64)}`, sha256: 'c'.repeat(64), mediaType: 'application/json',
      classification: 'sensitive' as const, redactionStatus: 'not_required' as const };
    const process = vi.spyOn(QARunner.prototype, 'process').mockImplementation(async function (this: QARunner) {
      const { observation } = this as unknown as { observation: NonNullable<import('./lifecycle.js').LifecycleContext['observation']> };
      expect(observation.context).toMatchObject({ runId: 'attempt-1', workItemId });
      await observation.record({ kind: 'effect.completed', effectKind: 'verification',
        idempotencyKey: 'qa-verification', outcome: 'succeeded' }, { idempotencyKey: 'qa-verification', evidence: [evidence] });
      current.state = 'merge_ready';
      return { success: true, mrUrl: 'https://github.com/acme/api/pull/5' };
    });
    try {
      expect(await executeWorkItem(input, deps)).toMatchObject({ status: 'merge_ready' });
      const history = [];
      for await (const event of store.read('attempt-1')) history.push(event);
      expect(history.find(event => event.type === 'effect.completed')).toMatchObject({
        context: { runId: 'attempt-1', workItemId }, idempotencyKey: 'qa-verification', evidence: [evidence],
      });
      expect((await store.verify('attempt-1')).valid).toBe(true);
    } finally { process.mockRestore(); }
  });
  it.each(['selected-default', 'selected-configured', 'first-configured'] as const)(
    'keeps independent QA failure collection within its configured feedback owner (%s)', async mode => {
      const { deps, process, directory } = await setup();
      vi.stubEnv('HOME', directory);
      const eventRoot = join(directory, 'events');
      vi.stubEnv('AFK_EVENT_STORE_DIR', eventRoot);
      const scope = 'github:acme/api';
      const source = { runId: input.executionId, workItemId };
      const selected = mode !== 'first-configured';
      const file = mode === 'selected-default' ? experienceStorePath(directory) : join(directory, 'configured.sqlite');
      const store = new ExperienceStore({ file, now: () => new Date('2026-11-16T00:00:00.000Z') });
      const plugins = new PluginRuntime();
      try {
        let before;
        if (selected) {
          const record = store.recordFailure({ scope, trigger: 'qa_rework', rootCause: 'Independent QA requires a correction.',
            action: 'Inspect the qa_rework evidence and validate a correction before retrying.',
            source: { runId: 'original', workItemId: `${scope}#1` }, evidence: ['run:original#qa.failed'] });
          store.verify(record.id, { runId: 'independent-qa', evidence: ['run:independent-qa#regression'] });
          const digest = createHash('sha256').update('selected QA context').digest('hex');
          const retrieved = store.recordContextRetrieval({ id: record.id, scope, source, selectionId: randomUUID(), fragmentDigest: digest });
          store.recordContextSelection({ retrieved, fragmentDigest: digest });
          for (let sequence = 1000; sequence < 1256; sequence++) {
            store.recordRunOutcome({ scope, source, event: { runId: source.runId, sequence, hash: digest,
              type: 'run.finished', outcome: 'succeeded', occurredAt: '2026-11-16T00:00:01.000Z', observedAt: '2026-11-16T00:00:01.000Z' } });
          }
          before = store.get(record.id, scope);
        }
        await plugins.load({ manifest: { id: 'context.test-owner', version: '1.0.0', apiVersion: 1,
          trusted: true, provides: ['context.provider'] }, activate(setup) {
          setup.registerContextProvider('context.experience', new ExperienceContextProvider(file));
        } });
        deps.plugins = plugins;
        delete deps.recordAudit;
        process.mockResolvedValueOnce({ success: false, rework: true, summary: 'Independent QA requires a correction.' } as any);
        expect((await executeWorkItem(input, deps)).status).toBe('rework');
        const history = [];
        for await (const event of new JsonlEventStore({ root: eventRoot }).read(source.runId)) history.push(event);
        expect(history.map(event => event.type)).toEqual(['qa.started', 'qa.failed', 'run.finished']);
        expect((await new JsonlEventStore({ root: eventRoot }).verify(source.runId)).valid).toBe(true);
        if (selected) {
          expect(store.get(before!.id, scope)).toEqual(before);
          expect(store.metrics({ scope }).recurrences).toBe(0);
          expect(store.outcomeReceipts({ scope, source })).toHaveLength(256);
        } else {
          expect(store.list({ scope })).toMatchObject([{ status: 'candidate', source }]);
        }
        if (mode !== 'selected-default') await expect(lstat(experienceStorePath(directory))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await plugins.dispose(); store.close(); }
    });

  it.each([undefined, 'execution', 'learning'] as const)('preserves QA failure audit and captures experience only for ordinary purpose (%s)', async purpose => {
    const { deps, process, directory } = await setup();
    vi.stubEnv('HOME', directory);
    process.mockResolvedValueOnce({ success: false, rework: true, summary: 'Independent QA requires a correction.' } as any);
    expect((await executeWorkItem({ ...input, purpose }, deps)).status).toBe('rework');
    const audit = vi.mocked(deps.recordAudit!).mock.calls;
    expect(audit.map(([, event]) => event.kind)).toEqual(['qa.started', 'qa.failed', 'run.finished']);
    expect(audit.every(([context]) => context.purpose === purpose)).toBe(true);
    if (purpose === 'learning') {
      await expect(lstat(experienceStorePath())).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      const experiences = new ExperienceStore({ file: experienceStorePath() });
      try { expect(experiences.list({ scope: 'github:acme/api' })).toMatchObject([{ source: { runId: 'attempt-1' } }]); }
      finally { experiences.close(); }
    }
  });

  it('creates its default manifest in AFK home and executes in the canonical loop workspace', async () => {
    const { deps, run } = await setup();
    delete deps.readManifest;
    deps.lookupWorkItem = vi.fn(async () => ({
      id: workItemId, issueNumber: 42, managed: true, executionEligible: true, executionMode: 'afk', state: 'ready',
      project: { platform: 'github', projectKey: 'acme/api', name: 'api', defaultBranch: 'main' },
      branchName: 'afk/backlog-42',
    } as any));
    const createContext = deps.createContext!;
    deps.createContext = vi.fn(async (manifest, request, config) => {
      expect(manifest.workspaceRoot).toBe(executionWorkspacePath(workItemId));
      expect(manifest.repositories[0].repoRoot).toBe(join(executionWorkspacePath(workItemId), 'repositories/api'));
      expect(manifest.manifestPath).toBe(executionManifestPath(workItemId));
      const result = await createContext(manifest, request, config);
      result.request.workspaceRoot = manifest.workspaceRoot;
      result.request.repoRoot = manifest.repositories[0].repoRoot;
      return result;
    });
    await executeWorkItem({ ...input, manifestPath: undefined }, deps);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ workspaceRoot: executionWorkspacePath(workItemId) }));
    expect(JSON.parse(await readFile(executionManifestPath(workItemId), 'utf8')).workItemId).toBe(workItemId);
  });

  it('derives the base branch from the ref the work item body declares', async () => {
    const { deps } = await setup();
    delete deps.readManifest;
    // The manifest of an earlier test lives at the same place; the derived
    // one is what this test is about.
    await rm(executionManifestPath(workItemId), { force: true });
    deps.lookupWorkItem = vi.fn(async () => ({
      id: workItemId, issueNumber: 42, managed: true, executionEligible: true, executionMode: 'afk', state: 'ready',
      project: { platform: 'github', projectKey: 'acme/api', name: 'api', defaultBranch: 'master' },
      branchName: 'afk/backlog-42',
      description: '## Base Version\n\n- Base Ref: 2025-11-8-show\n',
    } as any));

    await executeWorkItem({ ...input, executionId: 'attempt-base-ref', manifestPath: undefined }, deps);

    const manifest = JSON.parse(await readFile(executionManifestPath(workItemId), 'utf8'));
    expect(manifest.repositories[0].baseBranch).toBe('2025-11-8-show');
  });

  it('falls back to the repository default branch when the body declares no ref', async () => {
    const { deps } = await setup();
    delete deps.readManifest;
    await rm(executionManifestPath(workItemId), { force: true });
    deps.lookupWorkItem = vi.fn(async () => ({
      id: workItemId, issueNumber: 42, managed: true, executionEligible: true, executionMode: 'afk', state: 'ready',
      project: { platform: 'github', projectKey: 'acme/api', name: 'api', defaultBranch: 'master' },
      branchName: 'afk/backlog-42',
      description: '## Context\n\nno ref here',
    } as any));

    await executeWorkItem({ ...input, executionId: 'attempt-default-branch', manifestPath: undefined }, deps);

    const manifest = JSON.parse(await readFile(executionManifestPath(workItemId), 'utf8'));
    expect(manifest.repositories[0].baseBranch).toBe('master');
  });

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
    changes.get = vi.fn<[], Promise<ChangeRequest>>(async () => ({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open', sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' }));
    expect((await executeWorkItem(input, deps)).status).toBe('merge_ready');
    current.workItemId = undefined;
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'merge_ready' });
    expect(context.providers.backlog.transition).not.toHaveBeenCalled();
    changes.get.mockResolvedValue({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged', sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' });
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'done' });
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'done' });
    const result = await deps.loadExecution('attempt-1');
    expect(result.summary).toMatchObject({ status: 'done', pr: { state: 'merged' } });
    expect(result.timeline.events.filter(event => event.data.kind === 'change.merge_verified')).toHaveLength(1);
    expect(context.providers.backlog.transition).toHaveBeenCalledWith(workItemId, 'done', { changeId: '5' });
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
    changes.get = vi.fn<[], Promise<ChangeRequest>>(async () => ({ id: '5', url: 'https://github.com/acme/api/pull/other', state: 'merged', sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' }));
    await expect(reconcileWorkItemMerge(input, deps)).rejects.toThrow(/identity/);
    changes.get.mockResolvedValue({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged', sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' });
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
    changes.get = vi.fn<[], Promise<ChangeRequest>>(async () => ({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged', sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' }));
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
    changes.get = vi.fn<[], Promise<ChangeRequest>>(async () => ({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'merged', sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' }));
    const journalDirectory = join(workspaceDataDirectory(directory), 'executions');
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
    const change = { id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open' as const, sourceBranch: 'afk/backlog-42-qa', targetBranch: 'main' };
    changes.findForBacklog.mockResolvedValue(change);
    changes.get = vi.fn<[], Promise<ChangeRequest>>(async () => change);
    const journalDirectory = join(workspaceDataDirectory(directory), 'executions');
    await mkdir(journalDirectory, { recursive: true });
    await expect(reconcileWorkItemMerge(input, deps)).rejects.toThrow(/awaiting a verified root PR merge/);
    await writeFile(join(journalDirectory, 'attempt-1.jsonl'), JSON.stringify({ executionId: 'attempt-1', workItemId, phase: 'publication_requested' }) + '\n');
    await expect(reconcileWorkItemMerge(input, deps)).resolves.toMatchObject({ status: 'merge_ready', changeUrl: change.url });
    expect(context.providers.backlog.transition).toHaveBeenCalledWith(workItemId, 'merge_ready', { changeId: '5' });
    expect(context.providers.backlog.setExecutionMode).toHaveBeenCalledWith(workItemId, 'hitl');
    expect((await deps.loadExecution('attempt-1')).summary.status).toBe('awaiting_merge');
  });

  it.each([undefined, 'execution', 'learning'] as const)('writes one replayable execution stream and captures ordinary success only (%s)', async purpose => {
    const { deps, run, current, directory } = await setup();
    vi.stubEnv('HOME', directory);
    vi.stubEnv('AFK_EVENT_STORE_DIR', join(directory, 'events'));
    const store = new JsonlEventStore({ root: join(directory, 'events') });
    const observer = new RunObserver({ events: store });
    deps.recordAudit = (context, data) => observer.record(context, data);
    run.mockImplementation(async options => {
      if (!options.observationRunId || !options.observationWorkItemId) throw new Error('Missing execution observation identity');
      const context = { traceId: options.observationRunId, runId: options.observationRunId,
        workItemId: options.observationWorkItemId, profileId: 'test', attempt: 1,
        purpose: options.purpose,
        actor: { kind: 'system' as const, id: 'implementation' } };
      await observer.record(context, { kind: 'run.requested', run: { id: context.runId, workItemId: context.workItemId,
        profileId: context.profileId, attempt: 1, status: 'pending' } });
      await observer.record(context, { kind: 'run.started' });
      await observer.record(context, { kind: 'implementation.completed' });
      current.state = 'verification';
      return { success: true };
    });
    await expect(executeWorkItem({ ...input, purpose }, deps)).resolves.toMatchObject({ status: 'merge_ready' });
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ purpose }));
    const queried = await loadWorkItemExecution('attempt-1', createExecutionQueryPorts(store));
    expect(queried.timeline.integrity.lastSequence).toBe(7);
    expect(queried.summary).toMatchObject({ workItemId, status: 'awaiting_merge', pr: { id: '5', url: 'https://github.com/acme/api/pull/5' } });
    expect(queried.timeline.events.map(event => event.data.kind)).toEqual([
      'run.requested', 'run.started', 'implementation.completed', 'qa.started', 'qa.passed', 'change.published', 'human_gate.opened',
    ]);
    expect(queried.timeline.events.every(event => event.context.purpose === purpose)).toBe(true);
    expect((await replayRun('attempt-1', store)).state).toMatchObject({ run: { status: 'awaiting_human' }, terminal: false });
    const verification = verifyExperienceRun({ root: join(directory, 'events'), scope: 'github:acme/api',
      runId: 'attempt-1', evidence: ['run:attempt-1#regression'] });
    if (purpose === 'learning') {
      await expect(verification).rejects.toThrow(/Learning runs cannot verify/);
      await expect(lstat(experienceStorePath())).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      await expect(verification).resolves.toContain('run:attempt-1#qa.passed');
      const experiences = new ExperienceStore({ file: experienceStorePath() });
      try { expect(experiences.list({ scope: 'github:acme/api', status: 'verified' })).toContainEqual(expect.objectContaining({ kind: 'success', source: { runId: 'attempt-1', workItemId } })); }
      finally { experiences.close(); }
    }
  });

  it('records intent, claims through WorkflowRunner once, verifies independently, and only then succeeds', async () => {
    const { deps, run, process, changes, directory } = await setup();
    deps.createImplementation = vi.fn(() => {
      expect(getLogContext()).toEqual({ runId: 'attempt-1', workItemId });
      return { run } as any;
    });
    const result = await executeWorkItem(input, deps);
    expect(result).toMatchObject({ status: 'merge_ready', changeUrl: 'https://github.com/acme/api/pull/5' });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ backlogId: '42', session: 'attempt-1', template: 'implement', executionMode: 'interactive',
      observationRunId: 'attempt-1', observationWorkItemId: workItemId, auditRequired: true }));
    expect(process).toHaveBeenCalledWith('42');
    expect(changes.verifyIssueAssociation).toHaveBeenCalledWith(expect.objectContaining({ id: '5' }), workItemId);
    expect(vi.mocked(deps.recordAudit!).mock.calls.map(([, event]) => event.kind)).toEqual(['qa.started', 'qa.passed', 'change.published', 'human_gate.opened']);
    expect(vi.mocked(deps.recordAudit!).mock.calls.every(([context]) => context.runId === 'attempt-1' && context.workItemId === workItemId)).toBe(true);
    const events = (await readFile(join(workspaceDataDirectory(directory), 'executions', 'attempt-1.jsonl'), 'utf8')).trim().split('\n').map(entry => JSON.parse(entry));
    expect(events.map(event => event.phase)).toEqual(['requested', 'implementing', 'verifying', 'merge_ready']);
    expect(events.every(event => event.executionId === 'attempt-1' && event.workItemId === workItemId)).toBe(true);
  });

  it('persists the trusted QA target between QA start and pass for later applicability verification', async () => {
    const { deps, current } = await setup();
    const target = { target: { project: 'github:acme/api', revision: 'a'.repeat(40), dirty: false,
      productVersions: { sqlite: '3.45' } } };
    deps.createQA = undefined;
    const processQA = vi.spyOn(QARunner.prototype, 'process').mockImplementation(async function (this: QARunner) {
      const callback = (this as unknown as { onExperienceTarget?: (context: typeof target) => Promise<void> }).onExperienceTarget;
      if (!callback) throw new Error('Trusted QA target audit callback is missing');
      await callback(target);
      current.state = 'merge_ready';
      return { success: true, mrUrl: 'https://github.com/acme/api/pull/5' };
    });
    try {
      expect(await executeWorkItem(input, deps)).toMatchObject({ status: 'merge_ready' });
      const events = vi.mocked(deps.recordAudit!).mock.calls;
      expect(events.map(([, event]) => event.kind)).toEqual([
        'qa.started', 'decision.made', 'qa.passed', 'change.published', 'human_gate.opened',
      ]);
      expect(events[1]).toEqual([expect.objectContaining({ actor: { kind: 'system', id: 'execute' } }),
        { kind: 'decision.made', command: 'experience.qa-target', accepted: true, reason: JSON.stringify(target) }]);
    } finally { processQA.mockRestore(); }
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
      context.providers.backlog.get = vi.fn(async (id: string): Promise<BacklogItem> => id === '42' ? { ...item, ...override } : { ...item, state: 'ready' });
      deps.createContext = vi.fn(async () => context);
    }
    await expect(executeWorkItem(input, deps)).rejects.toThrow(message);
    expect(run).not.toHaveBeenCalled();
  });

  it('names the explicit command and labels needed to adopt a manually created issue', async () => {
    // `afk loop --work-item-id` cannot take over an issue the user filed by
    // hand, because `managed` and `executionEligible` are derived from labels.
    // The bare string "unmanaged work item" gives the operator no way forward.
    const { deps, run } = await setup({ managed: false });
    const message = await executeWorkItem(input, deps).then(() => '', (err: Error) => err.message);
    expect(message).toContain('afk backlog adopt --id 42 --project acme/api --platform github');
    expect(message).toMatch(/stage::ready-for-issues/);
    expect(message).toMatch(/mode::afk/);
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
    process.mockResolvedValueOnce({
      success: false,
      rework: true,
      summary: 'The API response is missing the required field.',
      failedCriteria: [{ id: 'api-response', expected: 'field is present', actual: 'field is missing' }],
    } as any);
    expect((await executeWorkItem(input, deps)).status).toBe('rework');
    expect(vi.mocked(deps.recordAudit!).mock.calls.map(([, event]) => event.kind)).toEqual(['qa.started', 'qa.failed', 'run.finished']);
    expect(vi.mocked(deps.recordAudit!).mock.calls[1][1]).toMatchObject({
      kind: 'qa.failed',
      reasonCode: 'qa_rework',
      summary: 'The API response is missing the required field.',
      failedCriteria: [{ id: 'api-response', expected: 'field is present', actual: 'field is missing' }],
    });
    expect(vi.mocked(deps.recordAudit!).mock.calls[2][1]).toMatchObject({ kind: 'run.finished', reasonCode: 'qa_rework' });
    const experiences = new ExperienceStore({ file: experienceStorePath() });
    try {
      expect(experiences.list({ scope: 'github:acme/api', status: 'candidate' })).toContainEqual(expect.objectContaining({
        trigger: 'qa_rework', evidence: ['run:attempt-1#qa.failed'],
        source: { runId: 'attempt-1', workItemId },
      }));
    } finally { experiences.close(); }
    const { deps: nextDeps, process: nextProcess } = await setup();
    nextProcess.mockResolvedValueOnce({ success: false } as any);
    expect((await executeWorkItem({ ...input, executionId: 'attempt-2' }, nextDeps)).status).toBe('blocked');
  });

  it('stores diagnostic details on qa.failed for an exceptional QA result', async () => {
    const { deps, process, directory } = await setup();
    const store = new JsonlEventStore({ root: join(directory, 'events') });
    const observer = new RunObserver({ events: store });
    deps.recordAudit = (context, data) => observer.record(context, data);
    process.mockResolvedValueOnce({ success: false, summary: 'QA execution failed: provider unavailable' } as any);

    await expect(executeWorkItem(input, deps)).resolves.toMatchObject({ status: 'blocked' });

    const events = [];
    for await (const event of store.read('attempt-1')) events.push(event);
    expect(events.find(event => event.data.kind === 'qa.failed')?.data).toMatchObject({
      kind: 'qa.failed',
      reason: 'blocked',
      summary: 'QA execution failed: provider unavailable',
    });
  });

  it.each(['returns', 'throws'] as const)('keeps caller audits cancelled when the default QA backlog read %s after its deadline', async outcome => {
    const { deps, get, current, directory } = await setup();
    vi.stubEnv('HOME', directory);
    deps.createQA = undefined;
    const eventRoot = join(directory, 'events');
    const store = new JsonlEventStore({ root: eventRoot });
    const evidence = await createLocalEncryptedEvidenceStore(directory);
    const records = new Map<string, EvidenceRecord>();
    const sdk: EvidenceStoreProvider = {
      id: 'qa-caller-memory', capabilities: { put: true, get: true, classify: false },
      put: vi.fn(async record => {
        records.set(record.id, { ...record, bytes: Buffer.from(record.bytes) });
        return { name: record.id, uri: `evidence://${record.id}` };
      }),
      get: vi.fn(async id => records.get(id)!),
    };
    const observer = createRunObserver(eventRoot, [], {
      evidenceStore: { provider: sdk, evidence, scopes: ['github:acme/api'], timeoutMs: 2000 },
    });
    await observer.record({ traceId: 'mirror-control', runId: 'mirror-control', workItemId, profileId: 'local',
      attempt: 1, actor: { kind: 'system', id: 'test' } }, { kind: 'qa.passed' });
    expect(sdk.put).toHaveBeenCalledTimes(1);
    expect(sdk.get).toHaveBeenCalledTimes(1);
    const auditSignals: Array<{ kind: string; signal: AbortSignal | undefined; aborted: boolean | undefined }> = [];
    deps.recordAudit = (context, data, options) => {
      const signal = getObservationSignal();
      auditSignals.push({ kind: data.kind, signal, aborted: signal?.aborted });
      return observer.record(context, data, options);
    };
    let qaSignal: AbortSignal | undefined;
    const original = new Error('backlog read failed after QA cancellation');
    get.mockImplementation(async () => {
      const signal = getObservationSignal();
      if (!signal) return current;
      qaSignal = signal;
      expect(signal.aborted).toBe(false);
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      if (outcome === 'throws') throw original;
      return current;
    });
    const context = await deps.createContext!({} as any, input, {} as any);
    const transition = vi.fn(async () => { current.state = 'blocked'; });
    context.providers.backlog.transition = transition;
    deps.createContext = vi.fn(async () => context);
    const config = workflowConfig.getWorkflowConfig();
    const configured = vi.spyOn(workflowConfig, 'getWorkflowConfig').mockReturnValue({ ...config, qaTimeout: 25 });
    try {
      await expect(executeWorkItem(input, deps)).resolves.toMatchObject({ status: 'blocked' });
      expect(qaSignal?.aborted).toBe(true);
      expect(qaSignal?.reason).toEqual(new Error('QA deadline exceeded (25ms)'));
      expect(auditSignals).toEqual([
        { kind: 'qa.started', signal: undefined, aborted: undefined },
        { kind: 'qa.failed', signal: qaSignal, aborted: true },
        { kind: 'run.finished', signal: qaSignal, aborted: true },
      ]);
      expect(getObservationSignal()).toBeUndefined();
      expect(sdk.put).toHaveBeenCalledTimes(1);
      expect(sdk.get).toHaveBeenCalledTimes(1);
      expect([...records.values()].map(record => JSON.parse(Buffer.from(record.bytes).toString()).kind)).toEqual(['qa.passed']);
      const history = [];
      for await (const event of store.read(input.executionId)) history.push(event);
      const summary = `QA execution failed: ${outcome === 'throws' ? original.message : 'QA deadline exceeded (25ms)'}`;
      expect(history.find(event => event.type === 'qa.failed')?.data).toMatchObject({
        kind: 'qa.failed', reason: 'blocked', reasonCode: 'qa_execution_failed', summary,
      });
      expect(history.find(event => event.type === 'run.finished')?.data).toMatchObject({
        kind: 'run.finished', outcome: 'failed', reasonCode: 'qa_execution_failed', reason: summary,
      });
      expect(transition).toHaveBeenCalledWith('42', 'blocked', { reason: summary });
      expect(await store.verify(input.executionId)).toMatchObject({ valid: true, lastSequence: history.length });
      for (const event of history.filter(event => ['qa.failed', 'run.finished'].includes(event.type))) {
        const captured = event.evidence!.at(-1)!;
        const bytes = await evidence.get(captured);
        expect(JSON.parse(Buffer.from(bytes).toString())).toMatchObject({ sourceEventId: event.id, kind: event.type });
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(captured.sha256);
        expect((await readFile(join(evidence.root, `${captured.sha256}.bin`))).equals(Buffer.from(bytes))).toBe(false);
      }
      const mirrors = history.filter(event => event.data.kind === 'effect.completed' && event.data.effectKind === 'evidence.mirror');
      expect(mirrors).toHaveLength(2);
      for (const mirror of mirrors) {
        expect(mirror.data).toMatchObject({ outcome: 'failed' });
        expect(JSON.parse(mirror.data.kind === 'effect.completed' ? mirror.data.summary! : '{}')).toMatchObject({ reason: 'cancelled' });
      }
    } finally { configured.mockRestore(); }
  });

  it('persists qa.failed when the real QARunner throws and preserves the original provider error', async () => {
    const { deps, get, directory } = await setup();
    const store = new JsonlEventStore({ root: join(directory, 'events') });
    const observer = new RunObserver({ events: store });
    deps.recordAudit = (context, data) => observer.record(context, data);
    const context = await deps.createContext!({} as any, input, {} as any);
    const original = new Error('backlog read unavailable');
    const transition = vi.fn(async () => { throw new Error('blocked write unavailable'); });
    context.providers.backlog.transition = transition;
    deps.createContext = vi.fn(async () => context);
    deps.createQA = (providers, config) => {
      get.mockRejectedValueOnce(original);
      return new QARunner(providers, config);
    };

    await expect(executeWorkItem(input, deps)).rejects.toBe(original);

    const events = [];
    for await (const event of store.read('attempt-1')) events.push(event);
    expect(events.map(event => event.data.kind)).toEqual(['qa.started', 'qa.failed', 'run.finished']);
    expect(events[1].data).toMatchObject({ kind: 'qa.failed', reason: 'blocked', summary: 'QA execution failed: backlog read unavailable' });
    expect(events[2].data).toMatchObject({ kind: 'run.finished', outcome: 'failed', reason: 'backlog read unavailable' });
    expect(transition).toHaveBeenCalledWith('42', 'blocked', { reason: 'QA execution failed: backlog read unavailable' });
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

  it('leaves a child waiting for a person rather than completing it', async () => {
    const { deps, current, process, changes } = await setup({ parentId: '41' });
    process.mockImplementationOnce(async () => {
      current.state = 'merge_ready';
      return { success: true, mrUrl: 'https://github.com/acme/api/pull/5' };
    });
    changes.findForBacklog.mockImplementation(async () => current.state === 'merge_ready'
      ? { id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open' } : null);
    // AFK never merges and never completes an item by itself: the change
    // waits for a person, and the reconciliation path is what brings the item
    // in line with a merge that already happened.
    expect((await executeWorkItem(input, deps)).status).toBe('merge_ready');
  });

  it('does not start a runner when attempt journaling is unavailable', async () => {
    const { deps, run, directory } = await setup();
    const journalDirectory = join(workspaceDataDirectory(directory), 'executions');
    await mkdir(journalDirectory, { recursive: true });
    await writeFile(join(journalDirectory, 'attempt-1.jsonl'), 'existing attempt');
    await expect(executeWorkItem(input, deps)).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('retries the same execution after a transient initial provider read without losing evidence or repeating implementation', async () => {
    const { deps, get, run, process, directory } = await setup();
    get.mockRejectedValueOnce(new Error('temporary provider failure'));
    await expect(executeWorkItem(input, deps)).rejects.toThrow('temporary provider failure');
    expect(run).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(deps.recordAudit).not.toHaveBeenCalled();
    const journalPath = join(workspaceDataDirectory(directory), 'executions', 'attempt-1.jsonl');
    const original = await readFile(journalPath, 'utf8');
    const identity = await lstat(journalPath);
    expect(original.trim().split('\n').map(entry => JSON.parse(entry))).toMatchObject([
      { phase: 'requested' }, { phase: 'failed', reason: 'temporary provider failure' },
    ]);

    await expect(executeWorkItem(input, deps)).resolves.toMatchObject({ status: 'merge_ready' });
    const recovered = await readFile(journalPath, 'utf8');
    expect(recovered.startsWith(original)).toBe(true);
    expect(await lstat(journalPath)).toMatchObject({ ino: identity.ino, dev: identity.dev, nlink: 1 });
    expect(recovered.trim().split('\n').map(line => JSON.parse(line).phase)).toEqual([
      'requested', 'failed', 'requested', 'implementing', 'verifying', 'merge_ready',
    ]);
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/journal/);
    expect(await readFile(journalPath, 'utf8')).toBe(recovered);
    expect(run).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.recordAudit!).mock.calls.map(([, event]) => event.kind)).toEqual([
      'qa.started', 'qa.passed', 'change.published', 'human_gate.opened',
    ]);
  });

  it('recovers an intact requested-only journal', async () => {
    const { deps, get, run, directory } = await setup();
    get.mockRejectedValueOnce(new Error('temporary provider failure'));
    await expect(executeWorkItem(input, deps)).rejects.toThrow('temporary provider failure');
    const journalPath = join(workspaceDataDirectory(directory), 'executions', 'attempt-1.jsonl');
    const requested = (await readFile(journalPath, 'utf8')).split('\n')[0] + '\n';
    await writeFile(journalPath, requested);
    await expect(executeWorkItem(input, deps)).resolves.toMatchObject({ status: 'merge_ready' });
    expect((await readFile(journalPath, 'utf8')).startsWith(requested)).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  const requested = { executionId: 'attempt-1', workItemId, phase: 'requested', at: '2026-11-08T00:00:00.000Z' };
  const failed = { ...requested, phase: 'failed', reason: 'temporary provider failure' };
  it.each([
    ['empty', ''],
    ['partial', JSON.stringify(requested)],
    ['malformed', '{broken}\n'],
    ['invalid UTF-8', Buffer.from([requested, { ...failed, reason: '\xff' }].map(entry => JSON.stringify(entry)).join('\n') + '\n', 'latin1')],
    ['null', 'null\n'],
    ['array', '[]\n'],
    ['blank line', JSON.stringify(requested) + '\n\n'],
    ['foreign work item', JSON.stringify({ ...requested, workItemId: 'github:other/api#42' }) + '\n'],
    ['foreign execution', JSON.stringify({ ...requested, executionId: 'another-attempt' }) + '\n'],
    ['foreign later record', [requested, { ...failed, workItemId: 'github:other/api#42' }].map(entry => JSON.stringify(entry)).join('\n') + '\n'],
    ['missing timestamp', JSON.stringify({ ...requested, at: undefined }) + '\n'],
    ['invalid timestamp', JSON.stringify({ ...requested, at: 'unknown' }) + '\n'],
    ['unknown field', JSON.stringify({ ...requested, changeId: '5' }) + '\n'],
    ['duplicate phase', JSON.stringify(requested).replace('"phase":"requested"', '"phase":"implementing","phase":"requested"') + '\n'],
    ['missing request', JSON.stringify(failed) + '\n'],
    ['malformed failure', [requested, { ...failed, reason: null }].map(entry => JSON.stringify(entry)).join('\n') + '\n'],
    ['oversize', (JSON.stringify(requested) + '\n').repeat(1024)],
    ...['unknown', 'implementing', 'verifying', 'publication_requested', 'published', 'merge_ready', 'done', 'blocked', 'not_claimed', 'rework']
      .map((phase): [string, string] => [phase, [requested, { ...requested, phase }, failed].map(entry => JSON.stringify(entry)).join('\n') + '\n']),
  ])('refuses a %s journal before provider access and preserves its evidence', async (_label, contents) => {
    const { deps, run, process, directory } = await setup();
    const journalDirectory = join(workspaceDataDirectory(directory), 'executions');
    await mkdir(journalDirectory, { recursive: true });
    const journalPath = join(journalDirectory, 'attempt-1.jsonl');
    await writeFile(journalPath, contents);
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/journal/);
    expect(await readFile(journalPath)).toEqual(Buffer.from(contents));
    expect(deps.createContext).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(process).not.toHaveBeenCalled();
    expect(deps.recordAudit).not.toHaveBeenCalled();
  });

  it.each(['symlink', 'hardlink', 'directory'])('refuses a %s journal without touching its target', async kind => {
    const { deps, run, directory } = await setup();
    const journalDirectory = join(workspaceDataDirectory(directory), 'executions');
    await mkdir(journalDirectory, { recursive: true });
    const target = join(journalDirectory, 'evidence');
    const contents = JSON.stringify(requested) + '\n';
    await writeFile(target, contents);
    const journalPath = join(journalDirectory, 'attempt-1.jsonl');
    if (kind === 'symlink') await symlink(target, journalPath);
    else if (kind === 'hardlink') await link(target, journalPath);
    else await mkdir(journalPath);
    const before = await lstat(journalPath);
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/journal/);
    expect(await lstat(journalPath)).toMatchObject({ ino: before.ino, dev: before.dev, nlink: before.nlink });
    expect(await readFile(target, 'utf8')).toBe(contents);
    expect(deps.createContext).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses retry after QA throws even when the final journal phase is failed', async () => {
    const { deps, run, process, directory } = await setup();
    process.mockRejectedValueOnce(new Error('QA unavailable'));
    await expect(executeWorkItem(input, deps)).rejects.toThrow('QA unavailable');
    const journalPath = join(workspaceDataDirectory(directory), 'executions', 'attempt-1.jsonl');
    const contents = await readFile(journalPath, 'utf8');
    expect(contents.trim().split('\n').map(line => JSON.parse(line).phase)).toEqual(['requested', 'implementing', 'verifying', 'failed']);
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/journal/);
    expect(await readFile(journalPath, 'utf8')).toBe(contents);
    expect(run).toHaveBeenCalledTimes(1);
    expect(process).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.recordAudit!).mock.calls.map(([, event]) => event.kind)).toEqual(['qa.started', 'qa.failed', 'run.finished']);
  });

  it('reports an existing open PR rather than starting a duplicate attempt', async () => {
    const { deps, run, changes } = await setup();
    changes.findForBacklog.mockResolvedValue({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open' });
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/already has an open change request/);
    expect(run).not.toHaveBeenCalled();
  });

  it('reuses the change request an earlier attempt left behind', async () => {
    // A reworked work item is expected to carry the review request of the
    // attempt that failed; the verification refreshes its evidence.
    const { deps, run, changes } = await setup({ state: 'rework' });
    changes.findForBacklog.mockResolvedValue({ id: '5', url: 'https://github.com/acme/api/pull/5', state: 'open' });
    await executeWorkItem(input, deps);
    expect(run).toHaveBeenCalled();
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
    const lockPath = join(workspaceDataDirectory(directory), 'executions', `${encodeWorkItemIdForPath(workItemId as NonNullable<BacklogItem['workItemId']>)}.lock`);
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
    const lockPath = join(workspaceDataDirectory(directory), 'executions', `${encodeWorkItemIdForPath(workItemId as NonNullable<BacklogItem['workItemId']>)}.lock`);
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
    const files = await readdir(join(workspaceDataDirectory(directory), 'executions'));
    const quarantined = files.filter(name => name.includes('.lock.stale-'));
    expect(quarantined).toHaveLength(1);
    expect(await readFile(join(workspaceDataDirectory(directory), 'executions', quarantined[0]), 'utf8')).toBe(JSON.stringify(priorOwner));
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
    expect((await readdir(join(workspaceDataDirectory(directory), 'executions'))).some(name => name.endsWith('.recovery'))).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed when its own process identity cannot be established', async () => {
    const { deps, directory, run } = await setup();
    deps.lockProbe = { identity: async () => undefined, status: async () => 'dead' };
    await expect(executeWorkItem(input, deps)).rejects.toThrow(/identity/);
    expect(await readdir(join(workspaceDataDirectory(directory), 'executions'))).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });
});
