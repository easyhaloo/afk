import { createRunObserver, type ObservabilityProviderSelection } from '../../infrastructure/observability/run-observer-factory.js';
import type { PluginRuntime } from './runtime.js';

export function createPluginRunObserver(plugins?: PluginRuntime, root = process.env.AFK_EVENT_STORE_DIR) {
  const providers: ObservabilityProviderSelection[] = [];
  const registrations = {
    'observability.provider': ['events', 'tracing', 'metrics'],
    'observe.event-store': ['events'],
    'observe.tracing': ['tracing'],
    'observe.metrics': ['metrics'],
  } as const;
  for (const [capability, signals] of Object.entries(registrations)) {
    for (const name of plugins?.listProviders(capability) ?? []) {
      const provider = plugins!.getProvider(capability, name);
      if (provider) providers.push({ provider, signals });
    }
  }
  return createRunObserver(root, providers);
}
