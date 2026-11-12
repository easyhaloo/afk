import { createRunObserver, evidenceStoreSelectionSchema, type ObservabilityProviderSelection, type RunObserverOptions } from '../../infrastructure/observability/run-observer-factory.js';
import type { EvidenceStoreProvider } from '../../plugin-sdk/capabilities.js';
import type { PluginRuntime } from './runtime.js';
import { experienceScope } from '../learning/runtime.js';

export interface PluginRunObserverOptions {
  readonly artifacts?: Omit<NonNullable<RunObserverOptions['artifacts']>, 'provider'> & { readonly provider: string };
  readonly evidenceStore?: Omit<NonNullable<RunObserverOptions['evidenceStore']>, 'provider' | 'isCurrent'> & { readonly provider: string };
}

const artifactSelections = new WeakMap<PluginRuntime, NonNullable<PluginRunObserverOptions['artifacts']>>();
const evidenceSelections = new WeakMap<PluginRuntime, NonNullable<PluginRunObserverOptions['evidenceStore']>>();

function selectedEvidenceProvider(runtime: PluginRuntime | undefined, name: string) {
  const specialized = runtime?.getProvider<EvidenceStoreProvider>('observe.evidence', name);
  const generic = runtime?.getProvider<EvidenceStoreProvider>('observability.provider', name);
  if (specialized && generic && specialized !== generic) throw new Error('Configured evidence store registration is ambiguous');
  const provider = specialized ?? generic;
  if (!provider || provider.capabilities?.put !== true || provider.capabilities?.get !== true
    || typeof provider.put !== 'function' || typeof provider.get !== 'function') throw new Error('Configured evidence store provider is unavailable');
  return provider;
}

export function setPluginAuditEvidence(runtime: PluginRuntime, options: NonNullable<PluginRunObserverOptions['evidenceStore']>): void {
  const selection = evidenceStoreSelectionSchema.parse({ provider: options.provider, scopes: options.scopes, timeoutMs: options.timeoutMs, maxBytes: options.maxBytes });
  selectedEvidenceProvider(runtime, selection.provider);
  if (typeof options.evidence.get !== 'function' || typeof options.evidence.put !== 'function') throw new Error('Evidence mirroring requires authoritative local storage');
  evidenceSelections.set(runtime, { ...options, ...selection });
}

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
  const savedEvidence = plugins && evidenceSelections.get(plugins);
  const evidence = options.evidenceStore ?? savedEvidence;
  let evidenceProvider: EvidenceStoreProvider | undefined;
  if (evidence) {
    try { evidenceProvider = selectedEvidenceProvider(plugins, evidence.provider); }
    catch (error) {
      if (options.evidenceStore) throw error;
      try { evidence.onFailure?.('provider_unavailable'); } catch {}
    }
  }
  return createRunObserver(root, providers, {
    artifacts: artifacts && provider ? { ...artifacts, provider } : undefined,
    evidenceStore: evidence && evidenceProvider ? {
      ...evidence, provider: evidenceProvider,
      isCurrent: () => {
        if (!options.evidenceStore && plugins && evidenceSelections.get(plugins) !== savedEvidence) return false;
        try { return selectedEvidenceProvider(plugins, evidence.provider) === evidenceProvider; }
        catch { return false; }
      },
    } : undefined,
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
