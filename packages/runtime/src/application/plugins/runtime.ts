import type { HostConnectionPort } from '@afk/core';
import type { AgentProvider } from '../../domain/agents/types.js';
import type { SandboxProvider } from '../../infrastructure/sandbox/types.js';
import type { WorkflowTemplate } from '../../domain/templates/types.js';
import type { LifecycleModule } from '../workflows/lifecycle.js';
import type { BacklogProvider } from '../../domain/backlog/index.js';
import type { TrackerProvider } from '../../domain/tracker/types.js';
import type { IssueTrackerPort } from '../../plugin-sdk/issue-tracker.js';
import type { Capability, PluginManifest } from '../../plugin-sdk/profile.js';
import type {
  ArtifactSink,
  ContextSource,
  CredentialProvider,
  EvidenceStoreProvider,
  EventStoreProvider,
  MetricsProvider,
  NotificationProvider,
  PolicyCheckProvider,
  RepositoryProvider,
  TriggerProvider,
  TracerProvider,
  VerificationProvider,
} from '../../plugin-sdk/capabilities.js';
import { AgentProviderRegistry } from '../../domain/agents/registry.js';
import { SandboxProviderRegistry } from '../../infrastructure/sandbox/registry.js';
import { validateManifest } from '../../plugin-sdk/profile.js';

export type PluginSystemAction = (input: unknown) => unknown | Promise<unknown>;
export type PluginProvider = object;
export type PluginSurface = object;
export type PluginHealthStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface PluginHealth {
  readonly pluginId?: string;
  readonly status: PluginHealthStatus;
  readonly message?: string;
  readonly checkedAt?: string;
  readonly details?: unknown;
}

export interface PluginDiagnostic {
  readonly pluginId?: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
}

export interface PluginSetupContext {
  getProvider<T extends PluginProvider>(capability: Capability, name: string): T | undefined;
  getCredentialProvider(name: string): CredentialProvider | undefined;
  registerCapability(capability: Capability, name: string, provider: PluginProvider): void;
  registerLifecycle(module: LifecycleModule): void;
  registerSystemAction(name: string, action: PluginSystemAction): void;
  registerAgentProvider(name: string, provider: AgentProvider): void;
  registerSandboxProvider(name: string, provider: SandboxProvider): void;
  registerTrackerProvider(name: string, provider: TrackerProvider): void;
  registerIssueTrackerProvider(name: string, provider: IssueTrackerPort): void;
  registerBacklogProvider(name: string, provider: BacklogProvider): void;
  registerHostProvider(name: string, provider: HostConnectionPort): void;
  registerVerificationProvider(name: string, provider: VerificationProvider): void;
  registerNotificationProvider(name: string, provider: NotificationProvider): void;
  registerTriggerProvider(name: string, provider: TriggerProvider): void;
  registerContextProvider(name: string, provider: ContextSource): void;
  registerCredentialProvider(name: string, provider: CredentialProvider): void;
  registerArtifactProvider(name: string, provider: ArtifactSink): void;
  registerRepositoryProvider(name: string, provider: RepositoryProvider): void;
  registerPolicyProvider(name: string, provider: PolicyCheckProvider): void;
  registerObservabilityProvider(name: string, provider: EventStoreProvider | EvidenceStoreProvider | TracerProvider | MetricsProvider): void;
  registerWorkflowTemplate(template: WorkflowTemplate): void;
  registerCliSurface(name: string, surface: PluginSurface): void;
  registerTuiSurface(name: string, surface: PluginSurface): void;
  registerDesktopSurface(name: string, surface: PluginSurface): void;
  onDispose(disposer: () => void | Promise<void>): void;

  /** Compatibility aliases for the exploratory plugin API. */
  lifecycle(module: LifecycleModule): void;
  systemAction(name: string, action: PluginSystemAction): void;
  agentProvider(name: string, provider: AgentProvider): void;
  sandboxProvider(name: string, provider: SandboxProvider): void;
  trackerProvider(name: string, provider: TrackerProvider): void;
  issueTrackerProvider(name: string, provider: IssueTrackerPort): void;
  backlogProvider(name: string, provider: BacklogProvider): void;
  hostProvider(name: string, provider: HostConnectionPort): void;
  template(template: WorkflowTemplate): void;
  dispose(disposer: () => void | Promise<void>): void;
}

export interface Plugin {
  readonly manifest: PluginManifest;
  activate(context: PluginSetupContext): void | Promise<void>;
  health?(): PluginHealth | Promise<PluginHealth>;
  diagnostics?(): readonly PluginDiagnostic[] | Promise<readonly PluginDiagnostic[]>;
}

/** Compatibility shape accepted while callers migrate to Plugin.activate(). */
export interface WorkflowPlugin {
  readonly id: string;
  readonly version: string;
  setup(context: PluginSetupContext): void | Promise<void>;
  health?(): PluginHealth | Promise<PluginHealth>;
  diagnostics?(): readonly PluginDiagnostic[] | Promise<readonly PluginDiagnostic[]>;
}

type RegistrationKind =
  | 'agent'
  | 'sandbox'
  | 'tracker'
  | 'issue-tracker'
  | 'backlog'
  | 'host'
  | 'verification'
  | 'notification'
  | 'trigger'
  | 'context'
  | 'credential'
  | 'artifact'
  | 'repository'
  | 'policy'
  | 'observability'
  | 'workflow-template'
  | 'cli-surface'
  | 'tui-surface'
  | 'desktop-surface';

type Registration = {
  readonly pluginId: string;
  readonly kind: RegistrationKind | 'custom';
  readonly value: PluginProvider;
};

type StagedRegistration = Registration & { readonly capability: Capability; readonly name: string };

type ActivationBatch = {
  plugin: Plugin;
  readonly registrations: StagedRegistration[];
  readonly actions: Array<{ readonly name: string; readonly action: PluginSystemAction }>;
  readonly lifecycles: LifecycleModule[];
  readonly templates: WorkflowTemplate[];
  readonly disposers: Array<() => void | Promise<void>>;
};

type PluginRecord = {
  readonly plugin: Plugin;
  readonly batch: ActivationBatch;
};

const CAPABILITY_BY_KIND: Readonly<Record<RegistrationKind, Capability>> = {
  agent: 'agent.provider',
  sandbox: 'sandbox.provider',
  tracker: 'tracker.provider',
  'issue-tracker': 'tracker.issue',
  backlog: 'backlog.provider',
  host: 'host.connection',
  verification: 'verification.provider',
  notification: 'notification.provider',
  trigger: 'trigger.provider',
  context: 'context.provider',
  credential: 'credential.provider',
  artifact: 'artifact.provider',
  repository: 'repository.provider',
  policy: 'policy.provider',
  observability: 'observability.provider',
  'workflow-template': 'workflow.template',
  'cli-surface': 'surface.cli',
  'tui-surface': 'surface.tui',
  'desktop-surface': 'surface.desktop',
};

export class PluginRuntime {
  private readonly plugins = new Map<string, PluginRecord>();
  private readonly capabilityOwners = new Map<Capability, string>();
  private readonly registrations = new Map<Capability, Map<string, Registration>>();
  private readonly actions = new Map<string, { readonly pluginId: string; readonly action: PluginSystemAction }>();
  private readonly lifecycles: Array<{ readonly pluginId: string; readonly module: LifecycleModule }> = [];
  private readonly templates = new Map<string, { readonly pluginId: string; readonly template: WorkflowTemplate }>();
  private readonly activationDiagnostics: PluginDiagnostic[] = [];

  async activate(plugin: Plugin | WorkflowPlugin): Promise<void> {
    const normalized = normalizePlugin(plugin);
    validateManifest(normalized.manifest);
    this.validateDependencies(normalized.manifest);

    const batch: ActivationBatch = {
      plugin: normalized,
      registrations: [],
      actions: [],
      lifecycles: [],
      templates: [],
      disposers: [],
    };
    try {
      await normalized.activate(this.createContext(normalized.manifest.id, batch));
      if (!isPlugin(plugin)) {
        batch.plugin = { ...normalized, manifest: { ...normalized.manifest, provides: this.batchCapabilities(batch) } };
      }
      this.validateDependencies(batch.plugin.manifest);
      this.validateBatch(batch.plugin.manifest, batch);
      this.commit(batch.plugin.manifest, batch);
    } catch (error) {
      await this.rollback(normalized.manifest.id, batch, error);
    }
  }

  /** Compatibility alias for the exploratory API. */
  async load(plugin: Plugin | WorkflowPlugin): Promise<void> {
    return this.activate(plugin);
  }

  listPlugins(): string[] { return [...this.plugins.keys()]; }

  getPlugin(id: string): Plugin | undefined { return this.plugins.get(id)?.plugin; }

  listCapabilities(): string[] { return [...this.capabilityOwners.keys()]; }

  listProviders(capability: Capability): string[] {
    return [...(this.registrations.get(capability)?.keys() ?? [])];
  }

  listProvidersForPlugin(pluginId: string): string[] {
    const names: string[] = [];
    for (const entries of this.registrations.values()) {
      for (const [name, registration] of entries) if (registration.pluginId === pluginId) names.push(name);
    }
    return names;
  }

  recordDiagnostic(diagnostic: PluginDiagnostic): void {
    this.activationDiagnostics.push(diagnostic);
  }

  getProvider<T extends PluginProvider>(capability: Capability, name: string): T | undefined {
    return this.registrations.get(capability)?.get(name)?.value as T | undefined;
  }

  listSystemActions(): string[] { return [...this.actions.keys()]; }

  getLifecycleModules(): LifecycleModule[] { return this.lifecycles.map(entry => entry.module); }

  getAgentProvider(name: string): AgentProvider | undefined { return this.getProvider('agent.provider', name); }
  getSandboxProvider(name: string): SandboxProvider | undefined { return this.getProvider('sandbox.provider', name); }
  getTrackerProvider(name: string): TrackerProvider | undefined { return this.getProvider('tracker.provider', name); }
  getIssueTrackerProvider(name: string): IssueTrackerPort | undefined { return this.getProvider('tracker.issue', name); }
  getBacklogProvider(name: string): BacklogProvider | undefined { return this.getProvider('backlog.provider', name); }
  getHostProvider(name: string): HostConnectionPort | undefined { return this.getProvider('host.connection', name); }
  getVerificationProvider(name: string): VerificationProvider | undefined { return this.getProvider('verification.provider', name); }
  getNotificationProvider(name: string): NotificationProvider | undefined { return this.getProvider('notification.provider', name); }
  getTriggerProvider(name: string): TriggerProvider | undefined { return this.getProvider('trigger.provider', name); }
  getContextProvider(name: string): ContextSource | undefined { return this.getProvider('context.provider', name); }
  getCredentialProvider(name: string): CredentialProvider | undefined { return this.getProvider('credential.provider', name); }
  getArtifactProvider(name: string): ArtifactSink | undefined { return this.getProvider('artifact.provider', name); }
  getRepositoryProvider(name: string): RepositoryProvider | undefined { return this.getProvider('repository.provider', name); }
  getPolicyProvider(name: string): PolicyCheckProvider | undefined { return this.getProvider('policy.provider', name); }
  getObservabilityProvider(name: string): PluginProvider | undefined { return this.getProvider('observability.provider', name); }
  getAgentProviderRegistry(): AgentProviderRegistry {
    return new AgentProviderRegistry(this.listProviders('agent.provider').flatMap(name => {
      const provider = this.getAgentProvider(name);
      return provider ? [provider] : [];
    }));
  }
  getSandboxProviderRegistry(): SandboxProviderRegistry {
    const registry = new SandboxProviderRegistry();
    for (const name of this.listProviders('sandbox.provider')) {
      const provider = this.getSandboxProvider(name);
      if (!provider) continue;
      registry.register({
        metadata: {
          id: name,
          label: name,
          capabilities: provider.capabilities,
          readiness: () => true,
          health: () => 'unknown',
        },
        factory: () => provider,
      });
    }
    return registry;
  }
  getTemplate(name: string): WorkflowTemplate | undefined { return this.templates.get(name)?.template; }
  listBacklogProviders(): string[] { return this.listProviders('backlog.provider'); }
  listIssueTrackerProviders(): string[] { return this.listProviders('tracker.issue'); }
  listHostProviders(): string[] { return this.listProviders('host.connection'); }

  async dispatchSystemAction(name: string, input: unknown): Promise<unknown> {
    const action = this.actions.get(name);
    if (!action) throw new Error(`unknown system action '${name}'`);
    return action.action(input);
  }

  async health(pluginId?: string): Promise<readonly PluginHealth[]> {
    const records = pluginId ? [this.plugins.get(pluginId)].filter(Boolean) as PluginRecord[] : [...this.plugins.values()];
    const results: PluginHealth[] = [];
    for (const record of records) {
      if (!record.plugin.health) {
        results.push({ pluginId: record.plugin.manifest.id, status: 'unknown', message: 'No health probe is registered' });
        continue;
      }
      try {
        const health = await record.plugin.health();
        results.push({ ...health, pluginId: record.plugin.manifest.id });
      } catch (error) {
        results.push({ pluginId: record.plugin.manifest.id, status: 'unhealthy', message: errorMessage(error) });
      }
    }
    return results;
  }

  async diagnostics(pluginId?: string): Promise<readonly PluginDiagnostic[]> {
    const records = pluginId ? [this.plugins.get(pluginId)].filter(Boolean) as PluginRecord[] : [...this.plugins.values()];
    const results = this.activationDiagnostics.filter(diagnostic => !pluginId || diagnostic.pluginId === pluginId);
    for (const record of records) {
      if (!record.plugin.diagnostics) continue;
      try {
        const diagnostics = await record.plugin.diagnostics();
        results.push(...diagnostics.map(diagnostic => ({ ...diagnostic, pluginId: record.plugin.manifest.id })));
      } catch (error) {
        results.push({ pluginId: record.plugin.manifest.id, severity: 'error', code: 'diagnostics.failed', message: errorMessage(error) });
      }
    }
    return results;
  }

  async dispose(pluginId?: string): Promise<void> {
    if (pluginId) {
      const target = this.plugins.get(pluginId);
      if (target) {
        const required = [...this.plugins.values()].find(record => record.plugin.manifest.id !== pluginId &&
          record.plugin.manifest.requires?.some(capability => target.plugin.manifest.provides.includes(capability) &&
            ![...this.plugins.values()].some(other => other !== target && other.plugin.manifest.provides.includes(capability))));
        if (required) throw new Error(`Plugin '${pluginId}' is required by '${required.plugin.manifest.id}'`);
      }
    }
    const ids = pluginId ? [pluginId] : [...this.plugins.keys()].reverse();
    const errors: unknown[] = [];
    for (const id of ids) {
      const record = this.plugins.get(id);
      if (!record) continue;
      for (const disposer of [...record.batch.disposers].reverse()) {
        try {
          await disposer();
        } catch (error) {
          errors.push(error);
        }
      }
      this.removeRecord(id, record);
    }
    if (errors.length) throw new AggregateError(errors, 'one or more plugins failed to dispose');
  }

  async close(): Promise<void> { return this.dispose(); }

  private createContext(pluginId: string, batch: ActivationBatch): PluginSetupContext {
    const register = (capability: Capability, name: string, value: PluginProvider, kind: RegistrationKind | 'custom'): void => {
      this.assertName(name, `${capability} provider`);
      if (!isObject(value)) throw new Error(`plugin '${pluginId}' registered an invalid ${capability} provider`);
      if (batch.registrations.some(entry => entry.capability === capability && entry.name === name)) {
        throw new Error(`duplicate ${capability} provider '${name}'`);
      }
      if (this.registrations.get(capability)?.has(name)) throw new Error(`duplicate ${capability} provider '${name}'`);
      batch.registrations.push({ pluginId, capability, name, kind, value });
    };
    const registerKind = (kind: RegistrationKind, name: string, value: PluginProvider): void => {
      register(CAPABILITY_BY_KIND[kind], name, value, kind);
    };
    const registerLifecycle = (module: LifecycleModule): void => {
      if (!module?.name || typeof module.name !== 'string') throw new Error(`plugin '${pluginId}' registered an invalid lifecycle module`);
      if (this.lifecycles.some(entry => entry.module.name === module.name) || batch.lifecycles.some(entry => entry.name === module.name)) {
        throw new Error(`duplicate lifecycle module '${module.name}'`);
      }
      batch.lifecycles.push(module);
    };
    const registerAction = (name: string, action: PluginSystemAction): void => {
      this.assertName(name, 'system action');
      if (typeof action !== 'function') throw new Error(`plugin '${pluginId}' registered an invalid system action`);
      if (this.actions.has(name) || batch.actions.some(entry => entry.name === name)) throw new Error(`duplicate system action '${name}'`);
      batch.actions.push({ name, action });
    };
    const registerTemplate = (template: WorkflowTemplate): void => {
      if (!template?.name || this.templates.has(template.name) || batch.templates.some(entry => entry.name === template.name)) {
        throw new Error(`duplicate or invalid workflow template '${template?.name ?? ''}'`);
      }
      batch.templates.push(template);
    };
    const registerSurface = (kind: 'cli-surface' | 'tui-surface' | 'desktop-surface', name: string, surface: PluginSurface): void => {
      registerKind(kind, name, surface);
    };
    const onDispose = (disposer: () => void | Promise<void>): void => {
      if (typeof disposer !== 'function') throw new Error(`plugin '${pluginId}' registered an invalid disposer`);
      batch.disposers.push(disposer);
    };

    return {
      getProvider: <T extends PluginProvider>(capability: Capability, name: string) => this.getProvider<T>(capability, name),
      getCredentialProvider: name => this.getCredentialProvider(name),
      registerCapability: (capability, name, provider) => register(capability, name, provider, 'custom'),
      registerLifecycle,
      registerSystemAction: registerAction,
      registerAgentProvider: (name, provider) => registerKind('agent', name, provider),
      registerSandboxProvider: (name, provider) => registerKind('sandbox', name, provider),
      registerTrackerProvider: (name, provider) => registerKind('tracker', name, provider),
      registerIssueTrackerProvider: (name, provider) => registerKind('issue-tracker', name, provider),
      registerBacklogProvider: (name, provider) => registerKind('backlog', name, provider),
      registerHostProvider: (name, provider) => registerKind('host', name, provider),
      registerVerificationProvider: (name, provider) => registerKind('verification', name, provider),
      registerNotificationProvider: (name, provider) => registerKind('notification', name, provider),
      registerTriggerProvider: (name, provider) => registerKind('trigger', name, provider),
      registerContextProvider: (name, provider) => registerKind('context', name, provider),
      registerCredentialProvider: (name, provider) => registerKind('credential', name, provider),
      registerArtifactProvider: (name, provider) => registerKind('artifact', name, provider),
      registerRepositoryProvider: (name, provider) => registerKind('repository', name, provider),
      registerPolicyProvider: (name, provider) => registerKind('policy', name, provider),
      registerObservabilityProvider: (name, provider) => registerKind('observability', name, provider),
      registerWorkflowTemplate: registerTemplate,
      registerCliSurface: (name, surface) => registerSurface('cli-surface', name, surface),
      registerTuiSurface: (name, surface) => registerSurface('tui-surface', name, surface),
      registerDesktopSurface: (name, surface) => registerSurface('desktop-surface', name, surface),
      onDispose,
      lifecycle: registerLifecycle,
      systemAction: registerAction,
      agentProvider: (name, provider) => registerKind('agent', name, provider),
      sandboxProvider: (name, provider) => registerKind('sandbox', name, provider),
      trackerProvider: (name, provider) => registerKind('tracker', name, provider),
      issueTrackerProvider: (name, provider) => registerKind('issue-tracker', name, provider),
      backlogProvider: (name, provider) => registerKind('backlog', name, provider),
      hostProvider: (name, provider) => registerKind('host', name, provider),
      template: registerTemplate,
      dispose: onDispose,
    };
  }

  private validateDependencies(manifest: PluginManifest): void {
    if (this.plugins.has(manifest.id)) throw new Error(`plugin '${manifest.id}' already loaded`);
    for (const conflict of manifest.conflicts ?? []) {
      if (this.plugins.has(conflict) || this.capabilityOwners.has(conflict)) throw new Error(`plugin '${manifest.id}' conflicts with '${conflict}'`);
    }
    for (const record of this.plugins.values()) {
      if (record.plugin.manifest.conflicts?.some(conflict => conflict === manifest.id || manifest.provides.includes(conflict))) {
        throw new Error(`plugin '${manifest.id}' conflicts with '${record.plugin.manifest.id}'`);
      }
    }
    for (const required of manifest.requires ?? []) {
      if (!this.capabilityOwners.has(required) && !manifest.provides.includes(required)) {
        throw new Error(`plugin '${manifest.id}' requires missing capability '${required}'`);
      }
    }
  }

  private validateBatch(manifest: PluginManifest, batch: ActivationBatch): void {
    for (const capability of this.batchCapabilities(batch)) {
      if (!manifest.provides.includes(capability)) throw new Error(`plugin '${manifest.id}' registered undeclared capability '${capability}'`);
    }
    for (const registration of batch.registrations) {
      if (this.registrations.get(registration.capability)?.has(registration.name)) throw new Error(`duplicate ${registration.capability} provider '${registration.name}'`);
    }
    for (const action of batch.actions) if (this.actions.has(action.name)) throw new Error(`duplicate system action '${action.name}'`);
    for (const module of batch.lifecycles) if (this.lifecycles.some(entry => entry.module.name === module.name)) throw new Error(`duplicate lifecycle module '${module.name}'`);
    for (const template of batch.templates) if (this.templates.has(template.name)) throw new Error(`duplicate workflow template '${template.name}'`);
  }

  private batchCapabilities(batch: ActivationBatch): Capability[] {
    return [...new Set([
      ...batch.registrations.map(registration => registration.capability),
      ...(batch.actions.length ? ['workflow.action'] : []),
      ...(batch.lifecycles.length ? ['workflow.lifecycle'] : []),
      ...(batch.templates.length ? ['workflow.template'] : []),
    ])];
  }

  private commit(manifest: PluginManifest, batch: ActivationBatch): void {
    for (const registration of batch.registrations) {
      const entries = this.registrations.get(registration.capability) ?? new Map<string, Registration>();
      entries.set(registration.name, registration);
      this.registrations.set(registration.capability, entries);
    }
    const provided = new Set<Capability>(manifest.provides);
    for (const registration of batch.registrations) provided.add(registration.capability);
    for (const capability of provided) if (!this.capabilityOwners.has(capability)) this.capabilityOwners.set(capability, manifest.id);
    for (const action of batch.actions) this.actions.set(action.name, { pluginId: manifest.id, action: action.action });
    for (const module of batch.lifecycles) this.lifecycles.push({ pluginId: manifest.id, module });
    for (const template of batch.templates) this.templates.set(template.name, { pluginId: manifest.id, template });
    this.plugins.set(manifest.id, { plugin: batch.plugin, batch });
  }

  private async rollback(pluginId: string, batch: ActivationBatch, error: unknown): Promise<never> {
    const rollbackErrors: unknown[] = [];
    for (const disposer of [...batch.disposers].reverse()) {
      try {
        await disposer();
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    const diagnostic: PluginDiagnostic = {
      pluginId,
      severity: 'error',
      code: 'activation.failed',
      message: errorMessage(error),
      details: rollbackErrors.length ? { rollbackErrors: rollbackErrors.map(errorMessage) } : undefined,
    };
    this.activationDiagnostics.push(diagnostic);
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], diagnostic.message);
    throw error;
  }

  private removeRecord(id: string, record: PluginRecord): void {
    this.plugins.delete(id);
    for (const [capability, entries] of this.registrations) {
      for (const [name, registration] of entries) if (registration.pluginId === id) entries.delete(name);
      if (!entries.size) this.registrations.delete(capability);
    }
    for (const [capability, owner] of this.capabilityOwners) {
      if (owner !== id) continue;
      const replacement = [...this.plugins.values()].find(candidate => candidate.plugin.manifest.provides.includes(capability)
        || candidate.batch.registrations.some(registration => registration.capability === capability));
      if (replacement) this.capabilityOwners.set(capability, replacement.plugin.manifest.id);
      else this.capabilityOwners.delete(capability);
    }
    for (const action of record.batch.actions) this.actions.delete(action.name);
    for (const module of record.batch.lifecycles) {
      const index = this.lifecycles.findIndex(entry => entry.pluginId === id && entry.module === module);
      if (index >= 0) this.lifecycles.splice(index, 1);
    }
    for (const template of record.batch.templates) this.templates.delete(template.name);
  }

  private assertName(name: string, kind: string): void {
    if (!/^[a-z][a-z0-9.-]*$/.test(name)) throw new Error(`invalid ${kind} name '${name}'`);
  }
}

function normalizePlugin(plugin: Plugin | WorkflowPlugin): Plugin {
  if (isPlugin(plugin)) return plugin;
  if (!plugin || typeof plugin.id !== 'string' || typeof plugin.version !== 'string' || typeof plugin.setup !== 'function') {
    throw new Error('invalid workflow plugin manifest');
  }
  return {
    manifest: { id: plugin.id, version: plugin.version, apiVersion: 1, provides: [], trusted: true },
    activate: plugin.setup.bind(plugin),
    health: plugin.health?.bind(plugin),
    diagnostics: plugin.diagnostics?.bind(plugin),
  };
}

function isPlugin(value: Plugin | WorkflowPlugin): value is Plugin {
  return !!value && typeof (value as Plugin).manifest === 'object' && typeof (value as Plugin).activate === 'function';
}

function isObject(value: unknown): value is object {
  return value !== null && typeof value === 'object';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
