import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApplicationFacade } from '../application/facade.js';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store.js';
import { registerObserveCommands } from './observe.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('observe execution queries', () => {
  it('routes the executions query through the CLI application facade', async () => {
    const calls: unknown[] = [];
    const output: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
    const program = new Command();
    const application: ApplicationFacade = {
      queryExecutionHistory: async input => {
        calls.push(input);
        return {
          executions: [{
            runId: 'run-1',
            workItemId: input.workItemId ?? '',
            profileId: 'profile-1',
            attempt: 1,
            status: 'pending',
            sequence: 1,
            terminal: false,
          }],
        };
      },
    };
    registerObserveCommands(program, {
      createApplication: () => application,
    });

    await program.parseAsync([
      'node', 'afk', 'observe', 'executions',
      '--work-item-id', 'github:team/project#158',
      '--limit', '3',
      '--since', 'run-0',
      '--json',
    ]);

    expect(calls).toEqual([{
      workItemId: 'github:team/project#158',
      limit: 3,
      since: 'run-0',
    }]);
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [{ runId: 'run-1', status: 'pending' }] });
  });

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
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [{ runId: 'impl-1', status: 'pending' }] });
    const filteredNextPage = new Command();
    registerObserveCommands(filteredNextPage);
    await filteredNextPage.parseAsync(['node', 'afk', 'observe', 'executions', '--work-item-id', workItemId, '--limit', '1', '--since', 'impl-1', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [] });
    const unfilteredProgram = new Command();
    registerObserveCommands(unfilteredProgram);
    await unfilteredProgram.parseAsync(['node', 'afk', 'observe', 'executions', '--limit', '1', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [{ runId: 'impl-2', workItemId: foreignWorkItemId }], nextCursor: 'impl-2' });
    const nextPageProgram = new Command();
    registerObserveCommands(nextPageProgram);
    await nextPageProgram.parseAsync(['node', 'afk', 'observe', 'executions', '--limit', '1', '--since', 'impl-2', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ executions: [{ runId: 'impl-1', workItemId }] });
    await program.parseAsync(['node', 'afk', 'observe', 'execution', 'impl-1', '--root', root, '--json']);
    expect(JSON.parse(output.pop()!)).toMatchObject({ runId: 'impl-1', integrity: { valid: true }, events: [{ id: 'one' }], state: { run: { status: 'pending' } } });
  });
});
