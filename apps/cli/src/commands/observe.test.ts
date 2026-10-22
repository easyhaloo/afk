import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunEvent, RunEventData, RunEventDraft } from '@afk/core';
import type { ApplicationFacade } from '../application/facade.js';
import { JsonlEventStore } from '@afk/runtime/infrastructure/observability/jsonl-event-store';
import { registerObserveCommands } from './observe.js';

const roots: string[] = [];
const initialExitCode = process.exitCode;
afterEach(async () => {
  process.exitCode = initialExitCode;
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function recordedRun(extra: RunEventData[] = []) {
  const root = await fs.mkdtemp(join(tmpdir(), 'afk-observe-text-'));
  roots.push(root);
  const store = new JsonlEventStore({ root });
  const context = { traceId: 'trace-run', runId: 'trace-run', workItemId: '229', profileId: 'local', attempt: 1, actor: { kind: 'system' as const, id: 'test' } };
  const data: RunEventData[] = [
    { kind: 'run.requested', run: { id: 'trace-run', workItemId: '229', profileId: 'local', attempt: 1, status: 'pending' } },
    { kind: 'run.started' },
    { kind: 'workspace.prepared', workspace: '/worktrees/229', branch: 'afk/backlog-229', baseBranch: 'main' },
    ...extra,
  ];
  const drafts: RunEventDraft[] = data.map((entry, index) => ({
    id: `event-${index}`, schemaVersion: 1, type: entry.kind, data: entry,
    occurredAt: new Date(Date.parse('2026-10-22T09:00:00Z') + index * 1000).toISOString(),
    context, correlationId: 'trace-run',
  }));
  await store.append(drafts);
  const events: RunEvent[] = [];
  for await (const event of store.read('trace-run')) events.push(event);
  return { root, events };
}

function captureCommand() {
  const output: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  registerObserveCommands(program);
  return { program, output };
}

describe('observe readable output and following', () => {
  it.each(['observe', 'log'])('supports the short %s <runId> form with existing text, JSON and watch options', async command => {
    const { root } = await recordedRun([{ kind: 'run.finished', outcome: 'succeeded' }]);
    const text = captureCommand();
    await text.program.parseAsync(['node', 'afk', command, 'trace-run', '--root', root, '--tail', '1', '--watch']);
    expect(text.output.join('')).toContain('/worktrees/229');
    expect(text.output.join('')).toContain('Showing 1 of 4 events');
    expect(text.output.join('')).toContain('Observation complete: SUCCEEDED');
    const json = captureCommand();
    await json.program.parseAsync(['node', 'afk', command, 'trace-run', '--root', root, '--json']);
    expect(JSON.parse(json.output.join(''))).toMatchObject({ runId: 'trace-run', integrity: { valid: true }, state: { run: { status: 'succeeded' } } });
  });

  it('shows detailed text by default and preserves the same JSON documents', async () => {
    const { root } = await recordedRun([{ kind: 'failure.classified', failureClass: 'workflow_crash', summary: 'git failed\nfull second line' }, { kind: 'run.finished', outcome: 'failed', reason: 'git failed' }]);
    for (const command of ['execution', 'timeline', 'replay']) {
      const { program, output } = captureCommand();
      await program.parseAsync(['node', 'afk', 'observe', command, 'trace-run', '--root', root]);
      expect(output.join('')).toContain('/worktrees/229');
      expect(output.join('')).toContain('FAILED');
      expect(output.join('')).toContain('full second line');
      await program.parseAsync(['node', 'afk', 'observe', command, 'trace-run', '--root', root, '--json']);
      const json = JSON.parse(output.at(-1)!);
      expect(command === 'replay' ? json.timeline : json).toMatchObject({ runId: 'trace-run', integrity: { valid: true }, state: { run: { status: 'failed' } } });
    }
  });

  it('tails complete events while keeping workspace context in the summary', async () => {
    const { root } = await recordedRun([{ kind: 'failure.classified', failureClass: 'workflow_crash', summary: 'failure\ncontinued detail' }]);
    const { program, output } = captureCommand();
    await program.parseAsync(['node', 'afk', 'observe', 'timeline', 'trace-run', '--root', root, '--tail', '1']);
    expect(output.join('')).toContain('/worktrees/229');
    expect(output.join('')).toContain('continued detail');
    expect(output.join('')).toContain('Showing 1 of 4 events');
    expect(output.join('')).not.toContain('Workspace prepared');
  });

  it.each(['-1', '1.5', '2events', 'Infinity', '9007199254740992'])('rejects invalid tail counts: %s', async tail => {
    const { program } = captureCommand();
    await expect(program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--tail', tail])).rejects.toMatchObject({ code: 'commander.invalidArgument' });
  });

  it.each([['--watch'], ['--tail', '1']])('rejects JSON combined with text-only options: %s', async (...flags) => {
    const { program } = captureCommand();
    await expect(program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--json', ...flags])).rejects.toMatchObject({ code: 'commander.conflictingOption' });
  });

  it('prints only new events, stays quiet without changes and exits on a terminal event', async () => {
    const { events } = await recordedRun([{ kind: 'run.finished', outcome: 'succeeded' }]);
    let snapshot = events.slice(0, 3);
    vi.spyOn(JsonlEventStore.prototype, 'read').mockImplementation(async function* () { yield* snapshot; });
    vi.spyOn(JsonlEventStore.prototype, 'verify').mockImplementation(async () => ({ valid: true, lastSequence: snapshot.length }));
    vi.useFakeTimers();
    const { program, output } = captureCommand();
    const running = program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--watch', '--tail', '0']);
    running.catch(() => {});
    await vi.waitFor(() => expect(output.join('')).toContain('Watching'));
    const initial = output.join('');
    await vi.advanceTimersByTimeAsync(1000);
    expect(output.join('')).toBe(initial);
    snapshot = events;
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(output.join('').match(/#4 Run finished/g)).toHaveLength(1);
    expect(output.join('').slice(initial.length)).not.toContain('#3 Workspace prepared');
    expect(output.join('')).toContain('Observation complete: SUCCEEDED');
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('stops only observation and removes both signal listeners on %s', async signal => {
    const { events } = await recordedRun();
    vi.spyOn(JsonlEventStore.prototype, 'read').mockImplementation(async function* () { yield* events; });
    vi.spyOn(JsonlEventStore.prototype, 'verify').mockResolvedValue({ valid: true, lastSequence: events.length });
    const listenersBefore = { SIGINT: process.listenerCount('SIGINT'), SIGTERM: process.listenerCount('SIGTERM') };
    const listeners = vi.spyOn(process, 'once');
    vi.useFakeTimers();
    const { program, output } = captureCommand();
    const running = program.parseAsync(['node', 'afk', 'observe', 'timeline', 'trace-run', '--watch']);
    running.catch(() => {});
    await vi.waitFor(() => expect(output.join('')).toContain('Watching'));
    const stop = listeners.mock.calls.find(([name]) => name === signal)?.[1];
    expect(stop).toBeTypeOf('function');
    stop!();
    await running;
    expect(output.join('')).toContain('Observation stopped');
    expect(process.listenerCount('SIGINT')).toBe(listenersBefore.SIGINT);
    expect(process.listenerCount('SIGTERM')).toBe(listenersBefore.SIGTERM);
  });

  it('does not wait on already finished runs and surfaces human gates', async () => {
    const { root } = await recordedRun([{ kind: 'human_gate.opened', gateId: 'merge:1', reason: 'awaiting human merge' }]);
    const { program, output } = captureCommand();
    await program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--root', root]);
    expect(output.join('')).toContain('AWAITING_HUMAN');
    expect(output.join('')).toContain('awaiting human merge');
    const finished = await recordedRun([{ kind: 'run.finished', outcome: 'failed', reason: 'test failure' }]);
    const finalCommand = captureCommand();
    await finalCommand.program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--root', finished.root, '--watch']);
    expect(finalCommand.output.join('')).toContain('Observation complete: FAILED');
    expect(finalCommand.output.join('')).not.toContain('Watching');
  });

  it('reports tampered streams without presenting their state as trusted', async () => {
    const { root } = await recordedRun();
    const path = join(root, `${Buffer.from('trace-run').toString('base64url')}.jsonl`);
    await fs.writeFile(path, (await fs.readFile(path, 'utf8')).replace('/worktrees/229', '/tampered/path'));
    const { program, output } = captureCommand();
    await program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--root', root, '--watch']);
    expect(output.join('')).toContain('INVALID');
    expect(output.join('')).toContain('integrity_mismatch');
    expect(output.join('')).not.toContain('/tampered/path');
    expect(output.join('')).not.toContain('Watching');
  });

  it('stops following if integrity fails after the initial snapshot', async () => {
    const { events } = await recordedRun();
    let valid = true;
    vi.spyOn(JsonlEventStore.prototype, 'read').mockImplementation(async function* () { yield* events; });
    vi.spyOn(JsonlEventStore.prototype, 'verify').mockImplementation(async () => valid
      ? { valid: true, lastSequence: events.length }
      : { valid: false, lastSequence: 0, reason: 'integrity_mismatch' });
    vi.useFakeTimers();
    const { program, output } = captureCommand();
    const running = program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--watch']);
    await vi.waitFor(() => expect(output.join('')).toContain('Watching'));
    valid = false;
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(output.join('')).toContain('State      UNKNOWN');
    expect(output.join('')).toContain('integrity_mismatch');
    expect(output.join('')).not.toContain('Observation complete');
  });

  it('reports shortened history as a readable error and cleans up the watcher', async () => {
    const { events } = await recordedRun();
    let snapshot = events;
    vi.spyOn(JsonlEventStore.prototype, 'read').mockImplementation(async function* () { yield* snapshot; });
    vi.spyOn(JsonlEventStore.prototype, 'verify').mockImplementation(async () => ({ valid: true, lastSequence: snapshot.length }));
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
    const previousListeners = process.listenerCount('SIGINT');
    vi.useFakeTimers();
    const { program, output } = captureCommand();
    const running = program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--watch']);
    await vi.waitFor(() => expect(output.join('')).toContain('Watching'));
    snapshot = events.slice(0, 1);
    await vi.advanceTimersByTimeAsync(1000);
    await running;
    expect(errors.join('')).toContain('Audit history changed');
    expect(errors.join('')).toContain('restart observe');
    expect(process.exitCode).toBe(1);
    expect(process.listenerCount('SIGINT')).toBe(previousListeners);
  });

  it('reports unreadable audit files without a stack trace', async () => {
    const { root } = await recordedRun();
    await fs.writeFile(join(root, `${Buffer.from('trace-run').toString('base64url')}.jsonl`), '{broken json\n');
    const errors: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
    const { program } = captureCommand();
    await program.parseAsync(['node', 'afk', 'observe', 'execution', 'trace-run', '--root', root]);
    expect(errors.join('')).toContain("Unable to observe run 'trace-run'");
    expect(errors.join('')).toContain('cannot parse event');
    expect(errors.join('')).not.toContain('    at ');
    expect(process.exitCode).toBe(1);
  });

  it('gives readable run lists, verification and doctor output and preserves their JSON shapes', async () => {
    const { root } = await recordedRun();
    for (const command of ['runs', 'verify', 'doctor']) {
      const { program, output } = captureCommand();
      const args = ['node', 'afk', 'observe', command, ...(command === 'verify' ? ['trace-run'] : []), '--root', root];
      await program.parseAsync(args);
      expect(output.join('').trim().startsWith('{')).toBe(false);
      expect(output.join('').trim().startsWith('[')).toBe(false);
      await program.parseAsync([...args, '--json']);
      const value = JSON.parse(output.at(-1)!);
      if (command === 'runs') expect(value).toEqual(['trace-run']);
      if (command === 'verify') expect(value).toMatchObject({ valid: true, lastSequence: 3 });
      if (command === 'doctor') expect(value).toEqual({ eventStoreRoot: root });
    }
  });
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
