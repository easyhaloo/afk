import { describe, expect, it, vi } from 'vitest';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import { WorkflowRunner, type RunnerDependencies } from './workflow-engine.js';
import { getLogContext } from '../infrastructure/io/index.js';
import type { RunObserver } from '../observability/run-observer.js';
import { RunObserver as DurableRunObserver } from '../observability/run-observer.js';
import { JsonlEventStore } from '../infrastructure/observability/jsonl-event-store.js';
import type { ObservationContext, RunEventData } from '@afk/core';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach } from 'vitest';
import { LifecycleDispatcher, type LifecycleContext } from './workflows/lifecycle.js';
import { createDefaultPluginRuntime } from './plugins/default-runtime.js';
import { createFailureDiagnostic, type FailureDiagnostic } from './workflows/failure-diagnostic.js';
import * as learningRuntime from './learning/runtime.js';
import { ExperienceStore } from './learning/experience-store.js';
import type { Step } from '../domain/templates/types.js';
import { PluginRuntime } from './plugins/runtime.js';
import { createLearningPlugin } from './plugins/learning.js';
import { createPluginRunObserver } from './plugins/observability.js';
import type { ContextQuery } from '../plugin-sdk/capabilities.js';
import { defaultSandboxProviderRegistry } from '../infrastructure/sandbox/registry.js';
import { BudgetManager } from './workflows/budget.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function runner(experienceContext?: RunnerDependencies['experienceContext'], plugins?: PluginRuntime, observer?: RunObserver) {
  const record = vi.fn(async (_context: ObservationContext, _data: RunEventData) => undefined);
  const claim = vi.fn(async () => null);
  const createExecution = vi.fn(async () => ({
    id: 'execution-42', metadata: { provider: 'claude-code', transport: 'process' },
    waitForResult: vi.fn(async () => ({ version: 1, runId: 'execution-42', status: 'completed', provider: 'local', commits: [] })),
  }));
  const workflow = new WorkflowRunner({ backlog: { claim, get: vi.fn(async () => ({ id: '42', state: 'ready' })) } } as unknown as ProviderBundle, {
    observer: observer ?? { record } as unknown as RunObserver,
    experienceContext,
    plugins,
    sandboxProviderRegistry: defaultSandboxProviderRegistry,
    agentProvider: { name: 'claude-code', capabilities: new Set(), createExecution } as never,
  });
  return { workflow, record, claim, createExecution };
}

describe('WorkflowRunner audit identity', () => {
  it('forwards lifecycle evidence through its existing observer and authoritative run identity', async () => {
    const { workflow, record } = runner();
    await workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main',
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' });
    const identity = record.mock.calls[0][0];
    const evidence = { uri: `evidence://${'a'.repeat(64)}`, sha256: 'a'.repeat(64), mediaType: 'application/json',
      classification: 'sensitive' as const, redactionStatus: 'not_required' as const };
    const data: RunEventData = { kind: 'effect.completed', effectKind: 'verification', idempotencyKey: 'verification-42', outcome: 'succeeded' };
    const options = { idempotencyKey: 'verification-42', evidence: [evidence] };
    const internals = workflow as unknown as {
      lifecycleDispatcher: LifecycleDispatcher;
      runLifecycleHooks(hooks: string[], context: LifecycleContext): Promise<void>;
    };
    const hook = vi.fn(async (context: LifecycleContext) => {
      expect(context.observation!.context).toEqual(identity);
      await context.observation!.record(data, options);
    });
    internals.lifecycleDispatcher = new LifecycleDispatcher([{ name: 'verification-test', failureMode: 'required', onAfterAgent: hook }]);
    await internals.runLifecycleHooks(['after'], { iid: 42, worktreePath: '/verification-workspace',
      baseBranch: 'main', sessionName: 'session-42', params: {} });
    expect(hook).toHaveBeenCalledOnce();
    expect(record).toHaveBeenLastCalledWith(identity, data, options);
    record.mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(internals.runLifecycleHooks(['after'], { iid: 42, worktreePath: '/verification-workspace',
      baseBranch: 'main', sessionName: 'session-42', params: {} })).rejects.toThrow('required audit event');
  });
  it.each(['selected-default', 'selected-configured', 'first-configured'] as const)(
    'keeps classified failure collection within its configured feedback owner (%s)', async mode => {
      const root = await fs.mkdtemp(join(tmpdir(), 'workflow-outcome-owner-'));
      roots.push(root);
      vi.stubEnv('HOME', root);
      const scope = 'github:acme/api';
      const source = { runId: 'feedback-capacity', workItemId: `${scope}#42` };
      const selected = mode !== 'first-configured';
      const file = mode === 'selected-default' ? learningRuntime.experienceStorePath(root) : join(root, 'configured.sqlite');
      const store = new ExperienceStore({ file, now: () => new Date('2026-11-16T00:00:00.000Z') });
      const plugins = new PluginRuntime();
      try {
        let before;
        if (selected) {
          const record = store.recordFailure({ scope, trigger: 'workflow_crash', rootCause: 'Execution failed.',
            action: 'Inspect the workflow_crash evidence and validate a correction before retrying.',
            source: { runId: 'original', workItemId: `${scope}#1` }, evidence: ['run:original#failure.classified'] });
          store.verify(record.id, { runId: 'independent-qa', evidence: ['run:independent-qa#regression'] });
          const digest = createHash('sha256').update('selected workflow context').digest('hex');
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
          setup.registerContextProvider('context.experience', new learningRuntime.ExperienceContextProvider(file));
        } });
        const eventRoot = join(root, 'events');
        const observer = createPluginRunObserver(plugins, eventRoot);
        const { workflow } = runner(undefined, plugins, observer);
        const internals = workflow as unknown as { observationContext: ObservationContext;
          classifyFailure(failure: FailureDiagnostic): Promise<FailureDiagnostic> };
        internals.observationContext = { ...source, traceId: source.runId, profileId: 'local', attempt: 1,
          actor: { kind: 'system', id: 'runner' } };
        await internals.classifyFailure(createFailureDiagnostic({ code: 'workflow_crash', message: 'Execution failed.' }));
        const history = [];
        for await (const event of new JsonlEventStore({ root: eventRoot }).read(source.runId)) history.push(event);
        expect(history.map(event => event.type)).toEqual(['failure.classified']);
        expect((await new JsonlEventStore({ root: eventRoot }).verify(source.runId)).valid).toBe(true);
        if (selected) {
          expect(store.get(before!.id, scope)).toEqual(before);
          expect(store.metrics({ scope }).recurrences).toBe(0);
          expect(store.outcomeReceipts({ scope, source })).toHaveLength(256);
        } else {
          expect(store.list({ scope })).toMatchObject([{ status: 'candidate', source }]);
        }
        if (mode !== 'selected-default') await expect(fs.lstat(learningRuntime.experienceStorePath(root))).rejects.toMatchObject({ code: 'ENOENT' });
      } finally { await plugins.dispose(); store.close(); }
    });

  it.each(['github:acme/api#42', undefined])('rejects a foreign observation identity before dispatch when workItemId is %s', async workItemId => {
    const root = await fs.mkdtemp(join(tmpdir(), 'canonical-backlog-context-'));
    roots.push(root);
    const recall = vi.spyOn(learningRuntime, 'prepareExperienceContext');
    const { workflow, createExecution } = runner();
    await workflow.run({ backlogId: '42', session: 'review', targetBranch: 'main',
      observationRunId: 'canonical-backlog', observationWorkItemId: 'github:foreign/private#88' });
    const internals = workflow as unknown as { activeBacklog: { id: string; workItemId?: string; title: string };
      runStep(step: Step, context: unknown, results: object): Promise<unknown> };
    internals.activeBacklog = { id: 'github:acme/api#42', workItemId, title: 'canonical backlog' };
    await expect(internals.runStep({ id: 'implement', prompt: 'sqlite retry' } as Step,
      { iid: 42, session: 'review', primaryWtPath: root, primaryBranch: 'main', executionMode: 'batch' }, {}))
      .rejects.toBeInstanceOf(learningRuntime.ExperienceFeedbackError);
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ workItemId: 'github:acme/api#42',
      source: { runId: 'canonical-backlog', workItemId: 'github:foreign/private#88' } }));
    expect(createExecution).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'foreign-project', 'foreign-item', 'recall-error', 'receipt-error'] as const)(
    'enforces builtin feedback identity and persistence before workflow dispatch (%s)', async boundary => {
      const root = await fs.mkdtemp(join(tmpdir(), 'workflow-feedback-'));
      roots.push(root);
      const file = join(root, 'experience.sqlite');
      const scope = 'github:acme/api';
      const source = { runId: `workflow-${boundary}`, workItemId: `${scope}#42` };
      const observedSource = { ...source, workItemId: boundary === 'foreign-project' ? 'github:foreign/private#88'
        : boundary === 'foreign-item' ? `${scope}#88` : source.workItemId };
      const store = new ExperienceStore({ file });
      try {
        const record = store.recordFailure({ scope, trigger: 'sqlite retry', rootCause: 'sqlite busy', action: 'retry sqlite transaction',
          evidence: ['run:sqlite-failure#failure.classified'], source: { runId: 'sqlite-failure', workItemId: `${scope}#1` } });
        store.verify(record.id, { runId: 'sqlite-verified', evidence: ['run:sqlite-verified#regression'] });
      } finally { store.close(); }
      const provider = new learningRuntime.ExperienceContextProvider(file);
      const plugins = new PluginRuntime();
      await plugins.activate({ manifest: { id: provider.id, version: '1.0.0', apiVersion: 1, provides: ['context.provider'], trusted: true },
        activate(context) { context.registerContextProvider(provider.id, provider); } });
      const failure = new Error(`${boundary} storage unavailable`);
      if (boundary === 'recall-error') vi.spyOn(ExperienceStore.prototype, 'recall').mockImplementation(() => { throw failure; });
      if (boundary === 'receipt-error') vi.spyOn(ExperienceStore.prototype, 'recordContextRetrieval').mockImplementation(() => { throw failure; });
      try {
        const { workflow, createExecution } = runner(undefined, plugins);
        await workflow.run({ backlogId: '42', session: 'review', targetBranch: 'main',
          observationRunId: observedSource.runId, observationWorkItemId: observedSource.workItemId });
        const internals = workflow as unknown as { activeBacklog: { id: string; workItemId: string; title: string };
          runStep(step: Step, context: unknown, results: object): Promise<{ status: string }> };
        internals.activeBacklog = { id: '42', workItemId: source.workItemId, title: 'sqlite retry' };
        const outcome = internals.runStep({ id: 'implement', prompt: 'sqlite retry' }, {
          iid: 42, session: 'review', primaryWtPath: root, primaryBranch: 'main', executionMode: 'batch',
          budget: new BudgetManager(4, 1_000_000), persistBudget: async () => {}, contextHighTokens: Infinity,
          hardTimeoutMs: 1000, completionTimeoutMs: 1000, idleTimeoutMs: 1000,
        }, {});
        if (boundary === 'accepted') {
          expect(await outcome).toMatchObject({ status: 'completed' });
          expect(createExecution).toHaveBeenCalledOnce();
        } else {
          await expect(outcome).rejects.toBeInstanceOf(learningRuntime.ExperienceFeedbackError);
          if (boundary === 'recall-error' || boundary === 'receipt-error') await expect(outcome).rejects.toMatchObject({ cause: failure });
          expect(createExecution).not.toHaveBeenCalled();
        }
        const reader = new ExperienceStore({ file });
        try {
          const receipts = reader.contextReceipts({ scope, source });
          expect(receipts.map(receipt => receipt.stage).sort()).toEqual(boundary === 'accepted' ? ['retrieved', 'selected'] : []);
          expect(receipts.every(receipt => JSON.stringify(receipt.source) === JSON.stringify(source))).toBe(true);
          if (boundary === 'foreign-item') expect(reader.contextReceipts({ scope, source: observedSource })).toEqual([]);
          expect(reader.metrics({ scope }).adoptions).toBe(0);
        } finally { reader.close(); }
      } finally { await plugins.dispose(); }
    });

  it.each(['explicit', 'saved'] as const)('reads knowledge and experience with %s trusted configuration through the managed execution entry', async source => {
    const root = await fs.mkdtemp(join(tmpdir(), 'managed-learning-context-'));
    roots.push(root);
    const queries: ContextQuery[] = [];
    const plugins = new PluginRuntime();
    await plugins.activate({ manifest: { id: 'managed.context', version: '1.0.0', apiVersion: 1, trusted: true, provides: ['context.provider'] },
      activate(context) {
        for (const id of ['context.experience', 'context.knowledge']) context.registerContextProvider(id, {
          id, capabilities: { 'read-only': true, summarize: false, search: true },
          async gather(query) { queries.push(query); return [{ origin: `${id}:verified-evidence`, content: 'trusted context '.repeat(1000) }]; },
        });
      } });
    const experienceContext = { applicability: { version: 'asset-2', environment: 'ci' },
      target: { project: 'github:acme/api', productVersions: { sqlite: '3.45' } } };
    if (source === 'saved') await plugins.activate(createLearningPlugin({ config: { executionContexts: [experienceContext] } }));
    try {
      const { workflow } = runner(source === 'explicit' ? experienceContext : undefined, plugins);
      await workflow.run({ backlogId: '42', session: 'context-42', targetBranch: 'main',
        observationRunId: 'execution-context', observationWorkItemId: 'github:acme/api#42' });
      const internals = workflow as unknown as {
        resolveStepPrompt(step: Step, context: undefined, worktreePath: string): Promise<{ segments: { label: string; text: string }[] }>;
      };
      const { segments } = await internals.resolveStepPrompt({ id: 'implement', prompt: 'SQLITE_BUSY; prompt Node 99' } as Step, undefined, root);
      expect(segments.some(segment => segment.label === 'verified experience reference')).toBe(true);
      expect(queries).toHaveLength(2);
      expect(queries[0]).toBe(queries[1]);
      expect(queries[0]).toMatchObject({ scope: 'github:acme/api', ...experienceContext });
      expect(queries[0].target?.runtimeVersions).toBeUndefined();
      const content = await fs.readFile(join(root, '.afk/experience-context.md'), 'utf8');
      expect(content).toContain('context.experience:verified-evidence');
      expect(content).toContain('context.knowledge:verified-evidence');
      expect(content.length).toBeLessThanOrEqual(8000);
    } finally { await plugins.dispose(); }
  });

  it.each([undefined, 'execution', 'learning'] as const)('preserves classified failure audit and captures ordinary experience only (%s)', async purpose => {
    const root = await fs.mkdtemp(join(tmpdir(), 'learning-purpose-failure-'));
    roots.push(root);
    vi.stubEnv('HOME', root);
    const { workflow, record } = runner();
    await workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main', purpose,
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' });
    const internals = workflow as unknown as { classifyFailure(failure: FailureDiagnostic): Promise<FailureDiagnostic> };
    await internals.classifyFailure(createFailureDiagnostic({ code: 'workflow_crash', message: 'Execution failed.' }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ purpose, runId: 'execution-42' }),
      expect.objectContaining({ kind: 'failure.classified', code: 'workflow_crash' }));
    expect(record.mock.calls.every(([context]) => context.purpose === purpose)).toBe(true);
    if (purpose === 'learning') {
      await expect(fs.lstat(learningRuntime.experienceStorePath())).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      const store = new ExperienceStore({ file: learningRuntime.experienceStorePath() });
      try { expect(store.list({ scope: 'github:acme/api' })).toMatchObject([{ source: { runId: 'execution-42' } }]); }
      finally { store.close(); }
    }
  });

  it.each([undefined, 'execution', 'learning'] as const)('injects verified experience context for ordinary purpose only (%s)', async purpose => {
    const root = await fs.mkdtemp(join(tmpdir(), 'learning-purpose-context-'));
    roots.push(root);
    const recall = vi.spyOn(learningRuntime, 'prepareExperienceContext').mockResolvedValue({ path: '.afk/experience-context.md', recordSelection: vi.fn(async () => {}) });
    const experienceContext = { applicability: { version: 'asset-2', environment: 'ci' },
      target: { project: 'github:acme/api', runtimeVersions: { node: '22.16' } } };
    const { workflow, record } = runner(experienceContext);
    await workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main', purpose,
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' });
    const internals = workflow as unknown as {
      resolveStepPrompt(step: Step, context: undefined, worktreePath: string): Promise<{ segments: { label: string; text: string }[] }>;
    };
    const { segments } = await internals.resolveStepPrompt({ id: 'implement', prompt: 'Implement the change.' } as Step, undefined, root);
    expect(segments.some(segment => segment.label === 'verified experience reference')).toBe(purpose !== 'learning');
    expect(recall).toHaveBeenCalledTimes(purpose === 'learning' ? 0 : 1);
    if (purpose !== 'learning') expect(recall).toHaveBeenCalledWith(expect.objectContaining(experienceContext));
    const recalled = record.mock.calls.filter(([, event]) => event.kind === 'decision.made' && event.command === 'experience.recall');
    expect(recalled).toHaveLength(purpose === 'learning' ? 0 : 1);
    expect(record.mock.calls.map(([, event]) => event.kind)).toContain('run.requested');
  });

  it('preserves disabled providers in the shared plugin registries', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'disabled-providers-'));
    roots.push(root);
    await fs.mkdir(join(root, '.afk'));
    await fs.writeFile(join(root, '.afk', 'plugins.yml'), JSON.stringify({ plugins: [{ id: 'agent.claude-code', enabled: false, builtin: true }, { id: 'sandbox.local', enabled: false, builtin: true }] }));
    const plugins = await createDefaultPluginRuntime({ homeDir: root, workspaceRoot: root });
    try {
      const workflow = new WorkflowRunner({} as ProviderBundle, { plugins, observer: { record: vi.fn() } as unknown as RunObserver });
      const internals = workflow as unknown as { agentProviderRegistry: { has(name: string): boolean }; sandboxProviderByName(name: string): unknown };
      expect(internals.agentProviderRegistry.has('claude-code')).toBe(false);
      expect(() => internals.sandboxProviderByName('local')).toThrow('unknown sandbox provider');
    } finally { await plugins.dispose(); }
  });
  it('blocks publication before any git or provider push when required policy rejects', async () => {
    const { workflow } = runner();
    const context: LifecycleContext = { iid: 42, worktreePath: '/missing-worktree', baseBranch: 'main', sessionName: 'session-42', params: {} };
    const internals = workflow as unknown as { lifecycleCtx: LifecycleContext; lifecycleDispatcher: LifecycleDispatcher; pushBranch(path: string): Promise<void> };
    internals.lifecycleCtx = context;
    internals.lifecycleDispatcher = new LifecycleDispatcher([{ name: 'security', failureMode: 'required', onBeforePublish: async () => { throw new Error('policy denied'); } }]);
    await expect(internals.pushBranch(context.worktreePath)).rejects.toThrow('policy denied');
  });
  it('uses deterministic run ID and canonical work item on the first requested event', async () => {
    const { workflow, record, claim } = runner();
    claim.mockImplementationOnce(async () => {
      expect(getLogContext()).toEqual({ runId: 'execution-42', workItemId: 'github:acme/api#42' });
      return null;
    });
    await workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main',
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' });
    expect(claim).toHaveBeenCalledWith('42', 'session-42');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ runId: 'execution-42', workItemId: 'github:acme/api#42' }),
      { kind: 'run.requested', run: expect.objectContaining({ id: 'execution-42', workItemId: 'github:acme/api#42' }) });
    expect(getLogContext()).toBeUndefined();
  });

  it('creates a UUID audit identity by default while keeping work item and backlog identities separate', async () => {
    const { workflow, record, claim } = runner();
    await workflow.run({ backlogId: '42', workItemId: 'github:acme/api#42', session: 'session-42', targetBranch: 'main' });
    const runId = record.mock.calls[0][0].runId;
    expect(runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(claim).toHaveBeenCalledWith('42', 'session-42');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ runId, traceId: runId, workItemId: 'github:acme/api#42' }),
      { kind: 'run.requested', run: expect.objectContaining({ id: runId, workItemId: 'github:acme/api#42' }) });
  });

  it('rejects invalid audit identity before recording or claiming', async () => {
    const { workflow, record, claim } = runner();
    await expect(workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main',
      observationRunId: '../unsafe', observationWorkItemId: 'github:acme/api#42' })).rejects.toThrow(/observationRunId/);
    expect(record).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();
  });

  it('persists events using the injected durable observer', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-required-audit-'));
    roots.push(root);
    const claim = vi.fn(async () => null);
    const workflow = new WorkflowRunner({ backlog: { claim, get: vi.fn(async () => ({ id: '42', state: 'ready' })) } } as unknown as ProviderBundle, {
      observer: new DurableRunObserver({ events: new JsonlEventStore({ root }) }),
      agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
    });
    await workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main', auditRequired: true,
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' });
    const events = (await fs.readFile(join(root, `${Buffer.from('execution-42').toString('base64url')}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(events[0]).toMatchObject({ type: 'run.requested', context: { runId: 'execution-42', workItemId: 'github:acme/api#42' }, data: { run: { workItemId: 'github:acme/api#42' } } });
  });

  it('fails before claiming if a required requested event cannot be persisted', async () => {
    const { workflow, record, claim } = runner();
    record.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main', auditRequired: true,
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' })).rejects.toThrow(/disk unavailable/);
    expect(claim).not.toHaveBeenCalled();
  });

  it('releases the claim and does not start work if required run.started persistence fails', async () => {
    const release = vi.fn(async () => undefined);
    const claim = vi.fn(async () => ({ item: { id: '42' }, release }));
    const record = vi.fn(async (_context: ObservationContext, data: RunEventData) => {
      if (data.kind === 'run.started') throw new Error('disk unavailable');
    });
    const workflow = new WorkflowRunner({ backlog: { claim, get: vi.fn(async () => ({ id: '42', state: 'ready' })), getActiveRework: vi.fn(async () => null) } } as unknown as ProviderBundle, {
      observer: { record } as unknown as RunObserver,
      agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
    });
    await expect(workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main', auditRequired: true,
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' })).rejects.toThrow(/disk unavailable/);
    expect(release).toHaveBeenCalledOnce();
    expect(record.mock.calls.map(([, data]) => data.kind)).toEqual(['run.requested', 'run.started']);
  });

  it('fails before claiming even when the caller does not request audit explicitly', async () => {
    const { workflow, record, claim } = runner();
    record.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main' }))
      .rejects.toThrow(/disk unavailable/);
    expect(claim).not.toHaveBeenCalled();
  });

  it('requires an injected observer at construction', () => {
    expect(() => new WorkflowRunner({} as ProviderBundle, {} as never)).toThrow(/requires an observer/);
  });
});
