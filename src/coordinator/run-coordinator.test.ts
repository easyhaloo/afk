import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evolve, initialRunAggregate, type ObservationContext } from '../core';
import { JsonlEventStore } from '../infrastructure/observability/jsonl-event-store';
import { RunCoordinator } from './run-coordinator';

const roots: string[] = [];
const context: ObservationContext = {
  traceId: 'trace-1', runId: 'run-1', workItemId: '42', profileId: 'test', attempt: 1,
  actor: { kind: 'system', id: 'test' },
};

async function root(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'afk-coordinator-'));
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

describe('RunCoordinator', () => {
  it('records the decision and each effect boundary around a successful command', async () => {
    const store = new JsonlEventStore({ root: await root() });
    let id = 0;
    const coordinator = new RunCoordinator({
      events: store,
      ids: { next: () => `event-${++id}` },
      effects: { execute: async effect => ({ summary: `executed:${effect.kind}` }) },
      now: () => new Date('2026-08-23T00:00:00.000Z'),
    });
    const requested = {
      id: 'event-requested', schemaVersion: 1 as const, type: 'run.requested' as const, sequence: 1,
      occurredAt: '2026-08-23T00:00:00.000Z', observedAt: '2026-08-23T00:00:00.000Z', context,
      correlationId: context.runId,
      data: { kind: 'run.requested' as const, run: { id: context.runId, workItemId: '42', profileId: 'test', attempt: 1, status: 'pending' as const } },
      integrity: { hash: 'fixture' },
    };
    const decision = await coordinator.dispatch(evolve(initialRunAggregate(), requested), context, { type: 'start', runId: context.runId });

    expect(decision.accepted).toBe(true);
    const events = [];
    for await (const event of store.read(context.runId)) events.push(event);
    expect(events.map(event => event.type)).toEqual(['decision.made', 'effect.started', 'effect.completed']);
    expect(events[1].idempotencyKey).toBe('run-1:start_run:run-1');
  });
});
