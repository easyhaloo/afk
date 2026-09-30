import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlEventStore } from './jsonl-event-store.js';
import { createRunObserver } from './run-observer-factory.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('createRunObserver', () => {
  it('persists audit events to the configured event store', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-run-observer-'));
    roots.push(root);
    const context = {
      traceId: 'trace-1', runId: 'run-1', workItemId: 'github:org/repo#1',
      profileId: 'test', attempt: 1, actor: { kind: 'cli' as const, id: 'test' },
    };

    await createRunObserver(root).record(context, {
      kind: 'run.requested',
      run: { id: context.runId, workItemId: context.workItemId, profileId: context.profileId, attempt: 1, status: 'pending' },
    });

    const store = new JsonlEventStore({ root });
    const events = [];
    for await (const event of store.read(context.runId)) events.push(event);
    expect(events).toMatchObject([{ type: 'run.requested', context }]);
    expect(await store.verify(context.runId)).toMatchObject({ valid: true, lastSequence: 1 });
  });
});
