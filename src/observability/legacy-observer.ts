import { JsonlEventStore } from '../infrastructure/observability/jsonl-event-store';
import { RunObserver } from './run-observer';

export type HarnessMode = 'legacy' | 'observe' | 'shadow' | 'coordinator';

export function harnessMode(value = process.env.AFK_HARNESS_MODE): HarnessMode {
  switch (value) {
    case 'observe':
    case 'shadow':
    case 'coordinator':
      return value;
    default:
      return 'legacy';
  }
}

/**
 * Phase-2 bridge: observe mode adds durable events without taking ownership of
 * existing state transitions. Coordinator mode is intentionally not enabled by
 * this factory until the coordinator is introduced.
 */
export function createLegacyRunObserverFromEnvironment(): RunObserver | undefined {
  if (harnessMode() === 'legacy') return undefined;
  return new RunObserver({
    events: new JsonlEventStore({ root: process.env.AFK_EVENT_STORE_DIR }),
  });
}
