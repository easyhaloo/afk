import pino from 'pino';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricsPort } from '@afk/core';
import { AuditPersistenceError } from '@afk/application';
import { JsonlEventStore } from '@afk/infrastructure/observability';
import { RunObserver } from './run-observer.js';

const roots: string[] = [];

async function root(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'afk-observer-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

describe('RunObserver', () => {
  it('persists the audit fact before returning and emits low-cardinality metrics', async () => {
    const counters: Array<{ name: string; attributes?: Record<string, string | number | boolean> }> = [];
    const metrics: MetricsPort = {
      counter: (name, _value, attributes) => counters.push({ name, attributes: attributes ? { ...attributes } : undefined }),
      histogram: () => undefined,
      gauge: () => undefined,
    };
    const observer = new RunObserver({
      events: new JsonlEventStore({ root: await root(), now: () => new Date('2026-08-23T00:00:02.000Z') }),
      metrics,
      clock: { now: () => new Date('2026-08-23T00:00:01.000Z') },
      ids: { next: () => 'event-1' },
      log: pino({ enabled: false }),
    });
    const context = {
      traceId: 'trace-1',
      runId: 'run-1',
      workItemId: '42',
      profileId: 'local-github-codex',
      attempt: 1,
      leaseEpoch: 2,
      actor: { kind: 'loop' as const, id: 'loop-1' },
    };

    const receipt = await observer.record(context, {
      kind: 'run.requested',
      run: { id: 'run-1', workItemId: '42', profileId: 'local-github-codex', attempt: 1, status: 'pending' },
    });

    expect(receipt.lastSequence).toBe(1);
    expect(counters).toEqual([{
      name: 'afk.run_events_total',
      attributes: { event_type: 'run.requested', profile_id: 'local-github-codex', actor_kind: 'loop' },
    }]);
  });

  it('names the failure when the event cannot be persisted', async () => {
    const observer = new RunObserver({
      events: {
        append: async () => { throw new Error('EACCES: permission denied'); },
        read: async function* () { /* the store holds nothing */ },
        listRuns: async () => [],
        verify: async () => ({ valid: true, lastSequence: 0 }),
      },
      log: pino({ enabled: false }),
    });
    const context = {
      traceId: 'trace-1',
      runId: 'run-1',
      workItemId: '42',
      profileId: 'local',
      attempt: 1,
      actor: { kind: 'loop' as const, id: 'loop-1' },
    };

    // The writer states the failure, so every entry point reads it the
    // same way - a managed work item included.
    const failure = observer.record(context, {
      kind: 'run.requested',
      run: { id: 'run-1', workItemId: '42', profileId: 'local', attempt: 1, status: 'pending' },
    });

    await expect(failure).rejects.toBeInstanceOf(AuditPersistenceError);
    await expect(failure).rejects.toThrow("required audit event 'run.requested' could not be persisted");
  });
});
