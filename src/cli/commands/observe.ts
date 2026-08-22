import { Command } from 'commander';
import { JsonlEventStore } from '../../infrastructure/observability/jsonl-event-store';
import { harnessMode } from '../../observability/legacy-observer';
import { RunQueryService } from '../../observability/query-service';

function queries(root?: string): RunQueryService {
  return new RunQueryService(new JsonlEventStore({ root }));
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

export function registerObserveCommands(program: Command): void {
  const observe = program.command('observe').description('Read append-only AFK run audit events');

  observe.command('timeline <runId>')
    .description('Show ordered audit events for a run')
    .option('--root <path>', 'Event-store root (defaults to AFK_EVENT_STORE_DIR or ~/.afk/events)')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => emit(await queries(options.root).timeline(runId), options.json));

  observe.command('verify <runId>')
    .description('Verify the event sequence and hash chain for a run')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => emit((await queries(options.root).timeline(runId)).integrity, options.json));

  observe.command('replay <runId>')
    .description('Replay a run event stream into aggregate state without effects')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => emit(await queries(options.root).replay(runId), options.json));

  observe.command('explain <runId>')
    .description('Explain why a run is running, blocked, terminal, or awaiting human review')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async (runId, options) => {
      const explanation = await queries(options.root).explain(runId);
      emit(options.json ? { runId, explanation } : explanation, options.json);
    });

  observe.command('doctor')
    .description('Report the current Harness observation mode and event-store location')
    .option('--root <path>', 'Event-store root')
    .option('--json', 'Emit JSON')
    .action(async options => {
      const store = new JsonlEventStore({ root: options.root });
      emit({ mode: harnessMode(), eventStoreRoot: store.root, writableOnObserve: harnessMode() !== 'legacy' }, options.json);
    });
}
