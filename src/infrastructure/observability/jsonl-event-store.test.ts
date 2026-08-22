import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ObservationContext, RunEventDraft } from '../../core/events';
import { JsonlEventStore } from './jsonl-event-store';

const roots: string[] = [];
const context: ObservationContext = {
  traceId: 'trace-1',
  runId: 'run-1',
  workItemId: '42',
  profileId: 'test',
  attempt: 1,
  actor: { kind: 'system', id: 'test' },
};

async function root(): Promise<string> {
  const path = await fs.mkdtemp(join(tmpdir(), 'afk-events-'));
  roots.push(path);
  return path;
}

function draft(id: string, kind: 'run.requested' | 'run.started', observation: ObservationContext = context): RunEventDraft {
  return {
    id,
    schemaVersion: 1,
    type: kind,
    occurredAt: '2026-08-23T00:00:00.000Z',
    context: observation,
    correlationId: observation.runId,
    data: kind === 'run.requested'
      ? { kind, run: { id: observation.runId, workItemId: observation.workItemId, profileId: observation.profileId, attempt: 1, status: 'pending' } }
      : { kind },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => fs.rm(path, { recursive: true, force: true })));
});

describe('JsonlEventStore', () => {
  it('assigns ordered sequences, hash chains, and survives a fresh store instance', async () => {
    const path = await root();
    const store = new JsonlEventStore({ root: path, now: () => new Date('2026-08-23T00:00:01.000Z') });
    const receipt = await store.append([draft('one', 'run.requested'), draft('two', 'run.started')]);

    expect(receipt).toMatchObject({ runId: context.runId, firstSequence: 1, lastSequence: 2 });
    const events = [];
    for await (const event of new JsonlEventStore({ root: path }).read(context.runId)) events.push(event);
    expect(events.map(event => event.sequence)).toEqual([1, 2]);
    expect(events[1].integrity.prevHash).toBe(events[0].integrity.hash);
    await expect(store.verify(context.runId)).resolves.toMatchObject({ valid: true, lastSequence: 2 });
  });

  it('lists no runs for a missing directory and discovers multiple encoded run IDs', async () => {
    const path = await root();
    const store = new JsonlEventStore({ root: path });
    await expect(store.listRuns()).resolves.toEqual([]);

    await store.append([draft('one', 'run.requested')]);
    const secondContext = { ...context, runId: 'run-2' };
    await store.append([draft('two', 'run.requested', secondContext)]);

    await expect(store.listRuns()).resolves.toEqual(['run-1', 'run-2']);
  });

  it('detects tampered payloads during verification', async () => {
    const path = await root();
    const store = new JsonlEventStore({ root: path });
    await store.append([draft('one', 'run.requested')]);
    const file = join(path, `${Buffer.from(context.runId).toString('base64url')}.jsonl`);
    const tampered = (await fs.readFile(file, 'utf8')).replace('run.requested', 'run.started');
    await fs.writeFile(file, tampered, 'utf8');

    await expect(store.verify(context.runId)).resolves.toMatchObject({ valid: false, reason: 'integrity_mismatch' });
  });
});
