import { describe, expect, it, vi } from 'vitest';
import type { ProviderBundle } from '../infrastructure/provider/providers.js';
import { WorkflowRunner } from './workflow-engine.js';
import { getLogContext } from '../infrastructure/io/index.js';
import type { RunObserver } from '../observability/run-observer.js';
import { RunObserver as DurableRunObserver } from '../observability/run-observer.js';
import { JsonlEventStore } from '../infrastructure/observability/jsonl-event-store.js';
import type { ObservationContext, RunEventData } from '@afk/core';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { LifecycleDispatcher, type LifecycleContext } from './workflows/lifecycle.js';
import { createDefaultPluginRuntime } from './plugins/default-runtime.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function runner() {
  const record = vi.fn(async (_context: ObservationContext, _data: RunEventData) => undefined);
  const claim = vi.fn(async () => null);
  const workflow = new WorkflowRunner({ backlog: { claim, get: vi.fn(async () => ({ id: '42', state: 'ready' })) } } as unknown as ProviderBundle, {
    observer: { record } as unknown as RunObserver,
    agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
  });
  return { workflow, record, claim };
}

describe('WorkflowRunner audit identity', () => {
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

  it('creates an afk run audit identity when overrides are absent', async () => {
    const { workflow, record } = runner();
    await workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ runId: expect.stringMatching(/^afk-42-/), workItemId: '42' }),
      { kind: 'run.requested', run: expect.objectContaining({ workItemId: '42' }) });
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
