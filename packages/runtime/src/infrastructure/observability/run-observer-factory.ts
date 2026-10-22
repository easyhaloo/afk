import { JsonlEventStore } from './jsonl-event-store.js';
import { RunObserver } from '../../observability/run-observer.js';

export function createRunObserver(root = process.env.AFK_EVENT_STORE_DIR): RunObserver {
  return new RunObserver({ events: new JsonlEventStore({ root }) });
}
