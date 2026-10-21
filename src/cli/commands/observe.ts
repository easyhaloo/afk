import { Command } from 'commander';
import { explainRun, listRunIds, observeRun } from '@afk/application';
import { observationProfile } from '@afk/core';
import { JsonlEventStore } from '@afk/infrastructure/observability';
import type { CliApplicationFactory } from '../composition-root.js';
import { createCliApplication } from '../composition-root.js';

/**
 * What the observe command is composed from.
 *
 * The application is a use case the command drives, and the command may
 * be handed a different one - a fixture, or a facade over a different
 * event store. The runtime's ports are not among them: observing a run
 * reads the audit spine, and the audit spine is not the runtime.
 */
export interface ObserveCommandComposition {
  /** The argv the command parses, when the caller has one of its own. */
  argv?: readonly string[];
  createApplication?: CliApplicationFactory;
}

function eventStore(root?: string): JsonlEventStore {
  return new JsonlEventStore({ root });
}

function emit(value: unknown, json?: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (typeof value === 'string') {
    process.stdout.write(`${value}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function registerObserveCommands(program: Command, composition: ObserveCommandComposition = {}): void {
  const observe = program.command('observe').description('Read append-only AFK run audit events');

  observe.command('runs')
    .description('List run IDs available in the local event store')
    .option('--root <path>', 'Event-store root (defaults to AFK_EVENT_STORE_DIR or ~/.afk/events)')
    .option('--json', 'Emit JSON')
    .action(async options => emit(await listRunIds(eventStore(options.root)), options.json));

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
      emit(page, options.json);
    });

  observe.command('execution <runId>')
    .description('Show one observed run and its verified timeline')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => emit(await observeRun(runId, eventStore(options.root)), options.json));

  observe.command('timeline <runId>')
    .description('Show ordered audit events for a run')
    .option('--root <path>', 'Event-store root (defaults to AFK_EVENT_STORE_DIR or ~/.afk/events)')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => emit(await observeRun(runId, eventStore(options.root)), options.json));

  observe.command('verify <runId>')
    .description('Verify the event sequence and hash chain for a run')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => emit((await observeRun(runId, eventStore(options.root))).integrity, options.json));

  observe.command('replay <runId>')
    .description('Replay a run event stream into aggregate state without effects')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => {
      const observed = await observeRun(runId, eventStore(options.root));
      emit({ timeline: observed, state: observed.state }, options.json);
    });

  observe.command('explain <runId>')
    .description('Explain why a run is running, blocked, terminal, or awaiting human review')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => {
      const explanation = await explainRun(runId, eventStore(options.root));
      emit(options.json ? { runId, explanation } : explanation, options.json);
    });

  observe.command('doctor')
    .description('Report where the audit trail lives and the profile it is recorded under')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async options => {
      const store = new JsonlEventStore({ root: options.root });
      emit({
        eventStoreRoot: store.root,
        // The profile is part of every event's identity, so a person
        // checking the audit trail wants to know which one it is under.
        profile: observationProfile(process.env.AFK_PROFILE),
      }, options.json);
    });
}
