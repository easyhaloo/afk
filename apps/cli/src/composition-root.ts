import { queryExecutionHistory } from '@afk/application';
import { JsonlEventStore } from '@afk/runtime/infrastructure/observability/jsonl-event-store';
import { createDefaultPluginRuntime, type DefaultPluginRuntimeOptions, type PluginRuntime } from '@afk/runtime/plugin-sdk';
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

export type CliPluginRuntimeOptions = DefaultPluginRuntimeOptions;

export async function createCliPluginRuntime(options: CliPluginRuntimeOptions = {}): Promise<PluginRuntime> {
  return createDefaultPluginRuntime(options);
}
