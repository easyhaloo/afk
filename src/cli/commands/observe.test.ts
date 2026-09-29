import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store';
import { registerObserveCommands } from './observe';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('observe execution queries', () => {
  it('lists exact work item matches and retrieves one verified run by stable runId', async () => {
    const root = await fs.mkdtemp(join(tmpdir(), 'afk-observe-cli-'));
    roots.push(root);
    const store = new JsonlEventStore({ root });
    const workItemId = 'github:team/project#158';
    await store.append([{ id: 'one', schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:00.000Z',
      context: { traceId: 'trace', runId: 'impl-1', workItemId, profileId: 'test', attempt: 1, actor: { kind: 'system', id: 'test' } },
      correlationId: 'attempt-1', data: { kind: 'run.requested', run: { id: 'impl-1', workItemId, profileId: 'test', attempt: 1, status: 'pending' } } }]);
    const foreignWorkItemId = 'github:other/project#158';
    await store.append([{ id: 'two', schemaVersion: 1, type: 'run.requested', occurredAt: '2026-09-29T00:00:01.000Z',
      context: { traceId: 'trace', runId: 'impl-2', workItemId: foreignWorkItemId, profileId: 'test', attempt: 1, actor: { kind: 'system', id: 'test' } },
      correlationId: 'attempt-2', data: { kind: 'run.requested', run: { id: 'impl-2', workItemId: foreignWorkItemId, profileId: 'test', attempt: 1, status: 'pending' } } }]);
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const program = new Command();
    registerObserveCommands(program);
    await program.parseAsync(['node', 'afk', 'observe', 'executions', '--work-item-id', workItemId, '--limit', '1', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [{ executionId: 'attempt-1', runId: 'impl-1', status: 'queued' }] });
    const filteredNextPage = new Command();
    registerObserveCommands(filteredNextPage);
    await filteredNextPage.parseAsync(['node', 'afk', 'observe', 'executions', '--work-item-id', workItemId, '--limit', '1', '--since', 'impl-1', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [] });
    const unfilteredProgram = new Command();
    registerObserveCommands(unfilteredProgram);
    await unfilteredProgram.parseAsync(['node', 'afk', 'observe', 'executions', '--limit', '1', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [{ executionId: 'attempt-2', runId: 'impl-2', workItemId: foreignWorkItemId }], nextCursor: 'impl-2' });
    const nextPageProgram = new Command();
    registerObserveCommands(nextPageProgram);
    await nextPageProgram.parseAsync(['node', 'afk', 'observe', 'executions', '--limit', '1', '--since', 'impl-2', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [{ executionId: 'attempt-1', runId: 'impl-1', workItemId }] });
    await program.parseAsync(['node', 'afk', 'observe', 'execution', 'impl-1', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ summary: { executionId: 'attempt-1' }, timeline: { integrity: { valid: true }, events: [{ id: 'one' }] } });
  });
});
