import { setTimeout } from 'node:timers/promises';
import { Command, InvalidArgumentError, Option } from 'commander';
import { explainRun, listRunIds, loadRunTimeline, observeRun, type ObserveRunResult } from '@afk/application';
import { initialRunAggregate, replay } from '@afk/core';
import { JsonlEventStore } from '@afk/runtime/infrastructure/observability/jsonl-event-store';
import type { CommandRegistrationContext } from '../command-registry.js';
import type { CliApplicationFactory } from '../composition-root.js';
import { createCliApplication } from '../composition-root.js';
import { formatEvent, formatExecutionHistory, formatIntegrity, formatRun, formatRunStatus } from './observe-output.js';

export interface ObserveCommandComposition extends CommandRegistrationContext {
  createApplication?: CliApplicationFactory;
}

function eventStore(root?: string): JsonlEventStore {
  return new JsonlEventStore({ root });
}

function emit(value: unknown, json: boolean | undefined, readable: string): void {
  process.stdout.write(`${json ? JSON.stringify(value, null, 2) : readable}\n`);
}

function parseTail(value: string): number {
  const count = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count)) {
    throw new InvalidArgumentError('tail must be a non-negative safe integer');
  }
  return count;
}

async function readObservation(runId: string, store: JsonlEventStore): Promise<ObserveRunResult> {
  const timeline = await loadRunTimeline(runId, store);
  return { ...timeline, state: timeline.integrity.valid ? replay(timeline.events) : initialRunAggregate() };
}

async function showRun(runId: string, options: { root?: string; json?: boolean; watch?: boolean; tail?: number }): Promise<void> {
  const store = eventStore(options.root);
  if (options.json) {
    const observed = await observeRun(runId, store);
    emit(observed, true, '');
    return;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (options.watch) {
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
  try {
    let observed = await readObservation(runId, store);
    process.stdout.write(`${formatRun(observed, options.tail)}\n`);
    if (!options.watch) return;
    let sequence = observed.events.at(-1)?.sequence ?? 0;
    if (observed.integrity.valid && !observed.state.terminal) {
      process.stdout.write('\nWatching for new events (every 1s). Ctrl-C stops observation.\n');
    }
    while (observed.integrity.valid && !observed.state.terminal && !controller.signal.aborted) {
      await setTimeout(1000, undefined, { signal: controller.signal });
      const next = await readObservation(runId, store);
      if (controller.signal.aborted) break;
      if (!next.integrity.valid) {
        process.stdout.write(`${formatRunStatus(next)}\n${formatIntegrity(next.integrity)}\n`);
        observed = next;
        break;
      }
      if (next.events.length < sequence || (sequence > 0 && next.events[sequence - 1]?.integrity.hash !== observed.events[sequence - 1]?.integrity.hash)) {
        throw new Error('Audit history changed during observation; restart observe to read the new stream.');
      }
      const added = next.events.filter(event => event.sequence > sequence);
      if (added.length) process.stdout.write(`${added.map(formatEvent).join('\n')}\n`);
      if (formatRunStatus(next) !== formatRunStatus(observed)) process.stdout.write(`${formatRunStatus(next)}\n`);
      sequence = next.events.at(-1)?.sequence ?? 0;
      observed = next;
    }
    if (controller.signal.aborted) process.stdout.write('Observation stopped.\n');
    else if (observed.state.terminal) process.stdout.write(`Observation complete: ${observed.state.run!.status.toUpperCase()}\n`);
  } catch (error) {
    if (controller.signal.aborted && error instanceof Error && error.name === 'AbortError') {
      process.stdout.write('Observation stopped.\n');
    } else {
      process.stderr.write(`Unable to observe run '${runId}': ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  } finally {
    if (options.watch) {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
  }
}

export function registerObserveCommands(program: Command, composition: ObserveCommandComposition = {}): void {
  const observe = program.command('observe').description('Read audit events; inspect a run with "afk observe <runId>"');

  observe.command('runs')
    .description('List run IDs available in the local event store')
    .option('--root <path>', 'Event-store root (defaults to AFK_EVENT_STORE_DIR or ~/.afk/events)')
    .option('--json', 'Emit JSON')
    .action(async options => {
      const runs = await listRunIds(eventStore(options.root));
      emit(runs, options.json, runs.length ? `Runs (${runs.length})\n${runs.join('\n')}` : 'No runs recorded.');
    });

  observe.command('executions')
    .description('List execution summaries across work items, optionally filtered by canonical ID')
    .option('--work-item-id <id>', 'Canonical provider-qualified work item ID')
    .option('--limit <count>', 'Maximum run streams to inspect (1–100)', '25')
    .option('--since <runId>', 'Continue after this run ID')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async options => {
      const application = (composition.createApplication ?? createCliApplication)({ eventStoreRoot: options.root });
      const page = await application.queryExecutionHistory({
        workItemId: options.workItemId,
        limit: Number(options.limit),
        since: options.since,
      });
      emit(page, options.json, formatExecutionHistory(page));
    });

  for (const command of [
    observe.command('execution <runId>', { isDefault: true }).description('Show one observed run and its verified timeline'),
    observe.command('timeline <runId>').description('Show ordered audit events for a run'),
    program.command('log <runId>').description('Show one observed run and its verified timeline'),
  ]) {
    command
      .option('--root <path>', 'Event-store root')
      .option('--json', 'Emit JSON')
      .addOption(new Option('--watch', 'Follow new events until the run finishes; Ctrl-C stops observation').conflicts('json'))
      .addOption(new Option('--tail <count>', 'Show the last N existing events; 0 starts with no history').argParser(parseTail).conflicts('json'))
      .action(showRun);
  }

  observe.command('verify <runId>')
    .description('Verify the event sequence and hash chain for a run')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => {
      const integrity = await eventStore(options.root).verify(runId);
      emit(integrity, options.json, formatIntegrity(integrity));
    });

  observe.command('replay <runId>')
    .description('Replay a run event stream into aggregate state without effects')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => {
      const store = eventStore(options.root);
      const observed = await (options.json ? observeRun(runId, store) : readObservation(runId, store));
      emit({ timeline: observed, state: observed.state }, options.json, formatRun(observed));
    });

  observe.command('explain <runId>')
    .description('Explain why a run is running, blocked, terminal, or awaiting human review')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => {
      const explanation = await explainRun(runId, eventStore(options.root));
      emit({ runId, explanation }, options.json, explanation);
    });

  observe.command('doctor')
    .description('Report the current Harness observation mode and event-store location')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async options => {
      const store = new JsonlEventStore({ root: options.root });
      emit({ eventStoreRoot: store.root }, options.json, `Event store  ${store.root}`);
    });
}
