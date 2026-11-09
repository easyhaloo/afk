import { createRunObserver, type ObservabilityProviderSelection, type RunObserverOptions } from '../../infrastructure/observability/run-observer-factory.js';
import type { PluginRuntime } from './runtime.js';
import { experienceScope } from '../learning/runtime.js';

export interface PluginRunObserverOptions {
  readonly artifacts?: Omit<NonNullable<RunObserverOptions['artifacts']>, 'provider'> & { readonly provider: string };
}

const artifactSelections = new WeakMap<PluginRuntime, NonNullable<PluginRunObserverOptions['artifacts']>>();

export function setPluginAuditArtifacts(runtime: PluginRuntime, options: NonNullable<PluginRunObserverOptions['artifacts']>): void {
  if (!runtime.getArtifactProvider(options.provider)?.capabilities.write) throw new Error('Configured audit artifact provider is not writable');
  if (options.captureEvents && !options.evidence.put) throw new Error('Event evidence capture requires a writable local evidence store');
  artifactSelections.set(runtime, { ...options });
}

export function createPluginRunObserver(plugins?: PluginRuntime, root = process.env.AFK_EVENT_STORE_DIR, options: PluginRunObserverOptions = {}) {
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
  const artifacts = options.artifacts ?? (plugins && artifactSelections.get(plugins));
  const provider = artifacts && plugins?.getArtifactProvider(artifacts.provider);
  if (artifacts && !provider) throw new Error('Configured audit artifact provider is not registered');
  return createRunObserver(root, providers, {
    artifacts: artifacts && provider ? { ...artifacts, provider } : undefined,
    onPersisted: plugins ? async draft => {
      if (draft.context.purpose === 'learning'
        || !['run.finished', 'qa.failed', 'human_gate.opened', 'change.merge_verified', 'agent.session_recorded'].includes(draft.type)
        || !plugins.listSystemActions().includes('learning.capture')) return;
      const settings = await plugins.dispatchSystemAction('learning.settings', {}) as { enabled: boolean };
      if (!settings.enabled) return;
      const result = await plugins.dispatchSystemAction('learning.capture', {
        scope: experienceScope(draft.context.workItemId), runId: draft.context.runId, ...(root ? { eventRoot: root } : {}),
      }) as { blocked: readonly unknown[] };
      if (result.blocked.length) throw new Error('learning_capture_degraded');
    } : undefined,
  });
}
