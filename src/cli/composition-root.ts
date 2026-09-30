import { queryExecutionHistory } from '@afk/application';
import { JsonlEventStore } from '../infrastructure/observability/jsonl-event-store.js';
import type { ApplicationFacade } from './application/facade.js';

export interface CliApplicationOptions {
  eventStoreRoot?: string;
}

export type CliApplicationFactory = (options: CliApplicationOptions) => ApplicationFacade;

export function createCliApplication(options: CliApplicationOptions = {}): ApplicationFacade {
  const events = new JsonlEventStore({ root: options.eventStoreRoot });
  return {
    queryExecutionHistory: input => queryExecutionHistory(input, events),
  };
}
