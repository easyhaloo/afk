import { describe, expect, it, vi } from 'vitest';
import type { ProviderBundle } from './providers';
import { WorkflowRunner } from './workflow-engine';
import type { RunObserver } from '../observability/run-observer';
import type { ObservationContext, RunEventData } from '../core/events';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function runner() {
  const record = vi.fn(async (_context: ObservationContext, _data: RunEventData) => undefined);
  const claim = vi.fn(async () => null);
  const workflow = new WorkflowRunner({ backlog: { claim } } as unknown as ProviderBundle, {
    observer: { record } as unknown as RunObserver,
    agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
  });
  return { workflow, record, claim };
}

describe('WorkflowRunner audit identity', () => {
  it('uses deterministic run ID and canonical work item on the first requested event', async () => {
    const { workflow, record, claim } = runner();
    await workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main',
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' });
    expect(claim).toHaveBeenCalledWith('42', 'session-42');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ runId: 'execution-42', workItemId: 'github:acme/api#42' }),
      { kind: 'run.requested', run: expect.objectContaining({ id: 'execution-42', workItemId: 'github:acme/api#42' }) });
  });

  it('keeps legacy afk run audit identity when overrides are absent', async () => {
    const { workflow, record } = runner();
    await workflow.run({ backlogId: '42', session: 'legacy', targetBranch: 'main' });
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

  it('creates an observer even in legacy harness mode when audit is required', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-required-audit-'));
    roots.push(root);
    vi.stubEnv('AFK_HARNESS_MODE', 'legacy');
    vi.stubEnv('AFK_EVENT_STORE_DIR', root);
    const claim = vi.fn(async () => null);
    const workflow = new WorkflowRunner({ backlog: { claim } } as unknown as ProviderBundle, {
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
    const workflow = new WorkflowRunner({ backlog: { claim, getActiveRework: vi.fn(async () => null) } } as unknown as ProviderBundle, {
      observer: { record } as unknown as RunObserver,
      agentProvider: { name: 'claude-code', capabilities: new Set() } as never,
    });
    await expect(workflow.run({ backlogId: '42', session: 'session-42', targetBranch: 'main', auditRequired: true,
      observationRunId: 'execution-42', observationWorkItemId: 'github:acme/api#42' })).rejects.toThrow(/disk unavailable/);
    expect(release).toHaveBeenCalledOnce();
    expect(record.mock.calls.map(([, data]) => data.kind)).toEqual(['run.requested', 'run.started']);
  });

  it('keeps legacy mode best-effort when observation fails', async () => {
    const { workflow, record, claim } = runner();
    record.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(workflow.run({ backlogId: '42', session: 'legacy', targetBranch: 'main' }))
      .resolves.toMatchObject({ skipped: 'not_claimed' });
    expect(claim).toHaveBeenCalledOnce();
  });
});
