import pino from 'pino';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MetricsPort } from '@afk/core';
import { JsonlEventStore } from '../infrastructure/observability/jsonl-event-store.js';
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
  it('runs derived intake after durable append and preserves the original result when intake fails', async () => {
    const events = new JsonlEventStore({ root: await root() });
    let called = false;
    const logs: string[] = [];
    const observer = new RunObserver({ events, log: pino({ level: 'warn' }, { write(line) { logs.push(line); } }), onPersisted: async () => {
      expect(await events.verify('r')).toMatchObject({ valid: true, lastSequence: 1 });
      called = true;
      throw new Error('PRIVATE_INTAKE_ERROR');
    } });
    const receipt = await observer.record({ traceId: 't', runId: 'r', workItemId: 'github:acme/wiki#42', profileId: 'local', attempt: 1,
      actor: { kind: 'system', id: 'test' } }, { kind: 'run.finished', outcome: 'succeeded' });
    expect(called).toBe(true);
    expect(receipt.lastSequence).toBe(1);
    expect(logs.join('')).toContain('derived_intake_failed');
    expect(logs.join('')).not.toContain('PRIVATE_INTAKE_ERROR');
  });
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
});
