import type { Plugin } from './runtime.js';
import type {
  ArtifactSink,
  ContextSource,
  CredentialProvider,
  EventStoreProvider,
  EvidenceStoreProvider,
  MetricsProvider,
  NotificationProvider,
  PolicyCheckProvider,
  RepositoryProvider,
  TriggerProvider,
  TracerProvider,
  VerificationProvider,
  ProviderHealth,
  ProviderDiagnostic,
} from '../../plugin-sdk/capabilities.js';
import type { IssueTrackerPort } from '../../plugin-sdk/issue-tracker.js';

export interface BuiltinCapabilityPluginOptions {
  readonly issueTrackers?: readonly IssueTrackerPort[];
  readonly verifications?: readonly VerificationProvider[];
  readonly notifications?: readonly NotificationProvider[];
  readonly triggers?: readonly TriggerProvider[];
  readonly contexts?: readonly ContextSource[];
  readonly credentials?: readonly CredentialProvider[];
  readonly artifacts?: readonly ArtifactSink[];
  readonly repositories?: readonly RepositoryProvider[];
  readonly policies?: readonly PolicyCheckProvider[];
  readonly observability?: readonly (EventStoreProvider | EvidenceStoreProvider | TracerProvider | MetricsProvider)[];
}

function pluginsFor<T extends { readonly id: string; health?: () => Promise<ProviderHealth>; doctor?: () => Promise<readonly ProviderDiagnostic[]>; dispose?: () => void | Promise<void> }>(
  capability: string,
  pluginPrefix: string,
  providers: readonly T[],
  register: (context: Parameters<Plugin['activate']>[0], name: string, provider: T) => void,
): Plugin[] {
  return providers.map(provider => ({
    manifest: { id: provider.id.startsWith(`${pluginPrefix}.`) ? provider.id : `${pluginPrefix}.${provider.id}`, version: '0.1.0', apiVersion: 1, provides: [capability], trusted: true },
    activate(context) {
      register(context, provider.id, provider);
      if (provider.dispose) context.onDispose(() => provider.dispose!());
    },
    async health() {
      if (!provider.health) return { status: 'unknown', message: 'No health probe is registered' };
      const health = await provider.health();
      return { status: health.status === 'ok' ? 'healthy' : health.status === 'unavailable' ? 'unhealthy' : 'degraded', message: health.message };
    },
    async diagnostics() {
      return (await provider.doctor?.() ?? []).filter(result => !result.ok).map(result => ({
        severity: 'warning' as const, code: `provider.${result.check}`, message: result.detail ?? `Provider check '${result.check}' failed`,
      }));
    },
  }));
}

export function createBuiltinCapabilityPlugins(options: BuiltinCapabilityPluginOptions = {}): Plugin[] {
  return [
    ...pluginsFor('tracker.issue', 'tracker', options.issueTrackers ?? [], (context, name, provider) => context.registerIssueTrackerProvider(name, provider)),
    ...pluginsFor('verification.provider', 'verification', options.verifications ?? [], (context, name, provider) => context.registerVerificationProvider(name, provider)),
    ...pluginsFor('notification.provider', 'notification', options.notifications ?? [], (context, name, provider) => context.registerNotificationProvider(name, provider)),
    ...pluginsFor('trigger.provider', 'trigger', options.triggers ?? [], (context, name, provider) => context.registerTriggerProvider(name, provider)),
    ...pluginsFor('context.provider', 'context', options.contexts ?? [], (context, name, provider) => context.registerContextProvider(name, provider)),
    ...pluginsFor('credential.provider', 'credential', options.credentials ?? [], (context, name, provider) => context.registerCredentialProvider(name, provider)),
    ...pluginsFor('artifact.provider', 'artifact', options.artifacts ?? [], (context, name, provider) => context.registerArtifactProvider(name, provider)),
    ...pluginsFor('repository.provider', 'repository', options.repositories ?? [], (context, name, provider) => context.registerRepositoryProvider(name, provider)),
    ...pluginsFor('policy.provider', 'policy', options.policies ?? [], (context, name, provider) => context.registerPolicyProvider(name, provider)),
    ...pluginsFor('observability.provider', 'observability', options.observability ?? [], (context, name, provider) => context.registerObservabilityProvider(name, provider)),
  ];
}
