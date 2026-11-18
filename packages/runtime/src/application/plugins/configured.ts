import { homedir } from 'node:os';
import { complianceSettings } from './shared-verification.js';
import { configuredExternalTools } from './builtin-manifests.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { HostConnectionPort } from '@afk/core';
import type { PluginManifest, PluginConfigValue } from '../../plugin-sdk/profile.js';
import type { ProviderDiagnostic, ProviderHealth, TriggerDescriptor, TriggerProvider, ArtifactSink } from '../../plugin-sdk/capabilities.js';
import type { Plugin, PluginSetupContext } from './runtime.js';
import { createBuiltinCapabilityPlugins } from './builtin-capabilities.js';
import { ExperienceContextProvider, experienceStorePath } from '../learning/runtime.js';
import type { KnowledgeRuntimeOptions } from '../learning/knowledge-runtime.js';
import { createJumpserverPlugin } from './builtins.js';
import { AgentProviderRegistry, ensureBuiltinAgentProviders } from '../../domain/agents/index.js';
import { createSshHostConnection, createAwsSsmHostConnection, createKubernetesExecHostConnection } from '../../infrastructure/host/index.js';
import type { HostCommandExecutor } from '../../infrastructure/host/command.js';
import { LinearTrackerProvider } from '../../infrastructure/tracker/linear-provider.js';
import { JiraTrackerProvider } from '../../infrastructure/tracker/jira-provider.js';
import { GitHubClient } from '../../infrastructure/github/client.js';
import { GitLabClient } from '../../infrastructure/gitlab/index.js';
import { createProviderBundle } from '../../infrastructure/provider/providers.js';
import type { TrackerProvider } from '../../domain/tracker/types.js';
import { RemoteContainerSandboxProvider, createRemoteContainerCliTransport, createRemoteContainerHttpTransport } from '../../infrastructure/sandbox/remote-container.js';
import type { RemoteContainerCliTransportOptions } from '../../infrastructure/sandbox/remote-container.js';
import { SandboxProviderRegistry, type SandboxProviderDeps } from '../../infrastructure/sandbox/registry.js';
import { WorktreeManager } from '../../infrastructure/git/worktree.js';
import { TestRunnerVerificationProvider, StaticScanVerificationProvider, BrowserCheckVerificationProvider } from '../../infrastructure/verification/index.js';
import {
  FeishuNotificationProvider, SlackNotificationProvider, EmailNotificationProvider, DesktopNotificationProvider,
  WebhookTriggerProvider, ScheduleTriggerProvider, GitPushTriggerProvider, IssueEventTriggerProvider,
  CodeContextProvider, KnowledgeBaseProvider, RetrievalProvider, ProjectMemoryProvider,
  SystemKeychainProvider, OAuthCredentialProvider, OidcCredentialProvider, EnterpriseCredentialProvider,
  GoogleOAuthCredentialProvider, GmailNotificationProvider, OAuthKeychainStore,
  TestReportProvider, EvidenceBundleProvider, ObjectStorageProvider, ReportPlatformProvider,
  MultiRepositoryProvider, RemoteWorkspaceProvider, SpecialGitBackendProvider,
  SecretScanPolicyProvider, LicensePolicyProvider, CompliancePolicyProvider,
  executeCommand,
} from '../../infrastructure/providers/index.js';
import { checkAbort, type CommandExecutor, type FetchTransport } from '../../infrastructure/providers/dependencies.js';
import { validateOperationCredential, type OperationSecret } from '../../infrastructure/providers/operation-secret.js';
import { OtlpObservabilityProvider } from '../../infrastructure/observability/otlp-provider.js';
import { createLearningPlugin, learningConfigurationSchema, learningPluginManifest } from './learning.js';

export interface ConfiguredTriggerEvent {
  readonly pluginId: string;
  readonly trigger: TriggerDescriptor;
  readonly payload?: unknown;
  readonly tick?: import('../../infrastructure/providers/triggers.js').ScheduledTriggerTick;
}

export interface ConfiguredPluginsOptions {
  readonly readToolSourcePolicy?: () => unknown;
  readonly configurations: readonly {
    readonly id: string;
    readonly config?: { readonly [key: string]: PluginConfigValue };
  }[];
  readonly homeDir?: string;
  readonly knowledge?: KnowledgeRuntimeOptions;
  readonly workspaceRoot?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: FetchTransport;
  readonly execute?: CommandExecutor;
  readonly hostExec?: HostCommandExecutor;
  readonly remoteRun?: RemoteContainerCliTransportOptions['run'];
  readonly sandboxDeps?: SandboxProviderDeps;
  readonly activateTriggers?: boolean;
  readonly onTrigger?: (event: ConfiguredTriggerEvent) => void | Promise<void>;
}

type ManagedProvider = object & {
  health?(): Promise<ProviderHealth>;
  doctor?(): Promise<readonly ProviderDiagnostic[]>;
  dispose?(): void | Promise<void>;
};

type PreparedPlugin = {
  readonly plugin: Plugin;
  readonly provider: ManagedProvider;
  readonly triggers?: readonly TriggerDescriptor[];
  readonly dependencies?: readonly string[];
  readonly prepare?: (context: PluginSetupContext) => Promise<PreparedPlugin>;
};
export interface ConfiguredPluginMetadata {
  readonly manifest: PluginManifest;
  readonly credentialDependencies: readonly string[];
}
type Definition = {
  readonly provides: readonly string[];
  readonly credentialDependencies?: readonly string[];
  inspect(config: unknown): { readonly provides: readonly string[]; readonly credentialDependencies: readonly string[] };
  create(config: unknown): PreparedPlugin;
};

export function configuredPluginManifests(): readonly PluginManifest[] {
  return Object.entries(configuredDefinitions({ configurations: [] }).definitions).map(([id, definition]) => configuredManifest(id, definition.provides, definition.credentialDependencies));
}

function configuredManifest(id: string, provides: readonly string[], dependencies: readonly string[] = []): PluginManifest {
  return { ...(id === 'learning.distiller' ? learningPluginManifest : { version: '0.1.0', apiVersion: 1 as const, trusted: true }), id, provides,
    ...(dependencies.length && !provides.includes('credential.provider') ? { requires: ['credential.provider'] } : {}) };
}

export function inspectConfiguredPlugins(options: Pick<ConfiguredPluginsOptions, 'configurations' | 'environment'>): readonly ConfiguredPluginMetadata[] {
  const definitions = configuredDefinitions({ configurations: [] }).definitions;
  const rows = new Map<string, ConfiguredPluginMetadata>();
  for (const { id, config } of options.configurations) {
    if (rows.has(id)) throw new Error(`duplicate configured plugin '${id}'`);
    if (!Object.hasOwn(definitions, id)) throw new Error(`unknown configured plugin '${id}'`);
    const definition = definitions[id];
    const { provides, credentialDependencies } = definition.inspect(config ?? {});
    rows.set(id, { manifest: configuredManifest(id, provides, credentialDependencies), credentialDependencies });
  }
  const ordered: ConfiguredPluginMetadata[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('cyclic configured credential dependencies');
    visiting.add(id);
    const row = rows.get(id)!;
    for (const name of row.credentialDependencies) if (rows.get(name)?.manifest.provides.includes('credential.provider')) visit(name);
    visiting.delete(id); visited.add(id); ordered.push(row);
  };
  for (const id of rows.keys()) visit(id);
  return ordered;
}

const configuredCredentialDependencies = new WeakMap<object, readonly string[]>();

export function getConfiguredCredentialDependencies(plugin: object): readonly string[] {
  return configuredCredentialDependencies.get(plugin) ?? [];
}

const text = z.string().trim().min(1).refine(value => !/[\0\r\n]/.test(value), 'must not contain control characters');
const environmentReference = z.object({ env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict();
const credentialReference = z.object({ provider: z.string().regex(/^[a-z][a-z0-9.-]*$/), name: text, scope: text.optional() }).strict();
const operationCredentialReference = credentialReference.extend({ expiresAt: z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value))).optional() });
const strings = z.array(text).min(1);
const httpUrl = text.refine(value => {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.hash;
  } catch { return false; }
}, 'must be an HTTP URL without embedded credentials or fragment');
const baseUrl = httpUrl.refine(value => !new URL(value).search, 'must not contain query parameters');
const httpsUrl = httpUrl.refine(value => new URL(value).protocol === 'https:', 'must use HTTPS');
const port = z.number().int().min(1).max(65535);
const milliseconds = z.number().int().positive().max(2_147_483_647);
const scalar = z.union([z.string(), z.number().finite(), z.boolean()]);
const filters = z.record(scalar);

function compliancePolicy(config: z.infer<typeof complianceSettings>) {
  return new CompliancePolicyProvider({ ...config, rules: config.rules.map(rule => ({ ...rule,
    when: rule.when && (context => Object.entries(rule.when!).every(([key, value]) => context[key] === value)) })) });
}
const jsonValue: z.ZodType<PluginConfigValue> = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]));
const triggerPayload = z.record(jsonValue);
const webhookDescriptors = z.array(z.object({ id: text, kind: z.literal('webhook'), payload: triggerPayload.optional(), input: triggerPayload.optional() }).strict()).min(1);
const scheduleDescriptors = z.array(z.object({
  id: text,
  kind: z.literal('schedule'),
  schedule: text.refine(value => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2_147_483_647, 'must be positive integer milliseconds'),
  payload: triggerPayload.optional(),
  input: triggerPayload.optional(),
}).strict()).min(1);

function configuredDefinitions(options: ConfiguredPluginsOptions) {
  const environment = options.environment ?? process.env;
  const secrets = new Set<string>();
  const environmentSecret = environmentReference.transform((ref, context) => {
    const value = environment[ref.env];
    if (!value?.trim() || /[\0\r\n]/.test(value)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'secret environment reference is missing, empty or invalid' });
      return z.NEVER;
    }
    secrets.add(value);
    secrets.add(value.trim());
    return value;
  });
  const secret = (context?: PluginSetupContext, dependencies?: Set<string>) => z.union([
    environmentSecret,
    credentialReference.transform((ref, validation) => {
      dependencies?.add(ref.provider);
      if (!context) return 'https://credential.invalid/validation-only';
      return (async () => {
        const provider = context.getCredentialProvider(ref.provider);
        if (!provider) throw new Error('credential provider is not active');
        let value: string;
        try { value = (await provider.resolve({ name: ref.name, ...(ref.scope ? { scope: ref.scope } : {}) })).secret; }
        catch { throw new Error('credential resolution failed'); }
        if (typeof value === 'string' && value) {
          secrets.add(value);
          if (value.trim()) secrets.add(value.trim());
        }
        if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value)) {
          validation.addIssue({ code: z.ZodIssueCode.custom, message: 'resolved credential is empty or invalid' });
          return z.NEVER;
        }
        return value;
      })();
    }),
  ]);
  const operationSecret = (context?: PluginSetupContext, dependencies?: Set<string>) => z.union([
    environmentSecret,
    operationCredentialReference.transform((ref): OperationSecret => {
      dependencies?.add(ref.provider);
      if (context && !context.getCredentialProvider(ref.provider)) throw new Error('credential provider is not active');
      let active = context !== undefined;
      context?.onDispose(() => { active = false; });
      return async operation => {
        if (!active) throw new Error('Operation credential unavailable');
        checkAbort(operation);
        if (ref.expiresAt !== undefined && Date.parse(ref.expiresAt) <= Date.now()) throw new Error('Operation credential unavailable');
        const provider = context?.getCredentialProvider(ref.provider);
        if (!provider) throw new Error('Operation credential unavailable');
        const value = await provider.resolve({ name: ref.name, ...(ref.scope ? { scope: ref.scope } : {}) }, operation);
        if (!active) throw new Error('Operation credential unavailable');
        if (typeof value?.secret === 'string' && value.secret) {
          secrets.add(value.secret);
          if (value.secret.trim()) secrets.add(value.secret.trim());
        }
        if (ref.expiresAt !== undefined && Date.parse(ref.expiresAt) <= Date.now()) throw new Error('Operation credential unavailable');
        const validated = validateOperationCredential(value);
        if (ref.expiresAt !== undefined && (validated.expiresAt === undefined || Date.parse(validated.expiresAt) > Date.parse(ref.expiresAt))) {
          return { ...validated, expiresAt: ref.expiresAt };
        }
        return validated;
      };
    }),
  ]);
  const fetch: FetchTransport = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
  const execute = options.execute ?? executeCommand;
  const path = (value: string): string => {
    if (value === '~' || value.startsWith('~/')) return resolve(options.homeDir ?? homedir(), value.slice(2));
    return resolve(options.workspaceRoot ?? process.cwd(), value);
  };
  const redact = (message: string): string => {
    for (const value of [...secrets].sort((left, right) => right.length - left.length)) message = message.split(value).join('[redacted]');
    return message;
  };
  const defineWithSecret = <SecretSchema extends z.ZodTypeAny>(secretFactory: (context?: PluginSetupContext, dependencies?: Set<string>) => SecretSchema, referenceSchema: typeof credentialReference | typeof operationCredentialReference = credentialReference) => <Schema extends z.ZodTypeAny>(provides: string | readonly string[], schema: Schema | ((value: SecretSchema) => Schema), create: (config: z.output<Schema>) => PreparedPlugin, providesForConfig?: (config: z.output<Schema>) => readonly string[], credentialDependencies: readonly string[] = []): Definition => ({
    provides: typeof provides === 'string' ? [provides] : provides,
    credentialDependencies,
    inspect(config) {
      const dependencies = new Set(credentialDependencies);
      const shapeSecret = z.union([
        environmentReference.transform(() => 'https://credential.invalid/shape-only'),
        referenceSchema.transform(ref => { dependencies.add(ref.provider); return 'https://credential.invalid/shape-only'; }),
      ]);
      const result = (typeof schema === 'function' ? schema(shapeSecret as unknown as SecretSchema) : schema).safeParse(config);
      if (!result.success) throw new Error(`invalid configuration fields: ${result.error.issues.map(issue => issue.path.join('.') || 'config').join(', ')}`);
      const triggers = result.data?.triggers as readonly { id: string }[] | undefined;
      if (triggers && new Set(triggers.map(item => item.id)).size !== triggers.length) throw new Error('trigger ids must be unique');
      return { provides: providesForConfig?.(result.data) ?? (typeof provides === 'string' ? [provides] : provides), credentialDependencies: [...dependencies] };
    },
    create(config) {
      const dependencies = new Set(credentialDependencies);
      const parse = (parsed: z.SafeParseReturnType<unknown, z.output<Schema>>): z.output<Schema> => {
        if (!parsed.success) {
          const fields = parsed.error.issues.map(issue => {
            const reason = issue.code === 'invalid_type' && issue.received === 'undefined' ? 'required' : issue.code === 'custom' ? issue.message : issue.code;
            return `${issue.path.join('.') || 'config'} (${reason})`;
          }).join(', ');
          throw new Error(`invalid configuration fields: ${fields}`);
        }
        return parsed.data;
      };
      const validationSchema = typeof schema === 'function' ? schema(secretFactory(undefined, dependencies)) : schema;
      const prepared = create(parse(validationSchema.safeParse(config)));
      return {
        ...prepared,
        dependencies: [...dependencies],
        prepare: dependencies.size && typeof schema === 'function'
          ? async context => create(parse(await schema(secretFactory(context)).safeParseAsync(config)))
          : prepared.prepare,
      };
    },
  });
  const define = defineWithSecret(secret);
  const defineOperation = defineWithSecret(operationSecret, operationCredentialReference);
  const capability = (provider: ManagedProvider, selection: Parameters<typeof createBuiltinCapabilityPlugins>[0]): PreparedPlugin => ({
    provider, plugin: createBuiltinCapabilityPlugins(selection)[0],
  });
  const direct = (provider: ManagedProvider, capabilityName: string | readonly string[], register: (context: PluginSetupContext) => void): PreparedPlugin => ({
    provider,
    plugin: {
      manifest: { id: 'configured.provider', version: '0.1.0', apiVersion: 1, provides: typeof capabilityName === 'string' ? [capabilityName] : capabilityName, trusted: true },
      activate(context) {
        if (provider.dispose) context.onDispose(() => provider.dispose!());
        register(context);
      },
    },
  });
  const tracker = (provider: TrackerProvider): PreparedPlugin => direct(provider as ManagedProvider, ['tracker.provider', 'backlog.provider'], context => {
    const bundle = createProviderBundle(provider, options.workspaceRoot ?? process.cwd());
    context.registerTrackerProvider(provider.platform, provider);
    context.registerBacklogProvider(provider.platform, bundle.backlog);
  });
  const host = (provider: HostConnectionPort, name: string): PreparedPlugin => direct(provider, 'host.connection', context => context.registerHostProvider(name, provider));
  const trigger = (provider: TriggerProvider & { dispose(): Promise<void> }, triggers: readonly TriggerDescriptor[]): PreparedPlugin => ({
    ...capability(provider, { triggers: [provider] }), triggers,
  });
  const fire = (pluginId: string, trigger: TriggerDescriptor, payload?: unknown): void | Promise<void> => options.onTrigger!({ pluginId, trigger, payload });
  const hostFields = { id: text.optional(), alias: text, address: text };
  const commandConfig = z.object({ command: strings, timeoutMs: milliseconds.optional() }).strict();
  const repositoryLifecycle = z.object({
    repositories: z.array(z.object({ url: text, ref: text.optional() }).strict()).min(1),
    operations: z.array(z.enum(['prepare', 'checkout', 'publish', 'cleanup'])).min(1),
  }).strict();
  const definitions: Record<string, Definition> = {
    'observability.otlp': defineOperation('observability.provider', secret => z.object({
      endpoint: baseUrl.refine(value => !/[?#]/.test(value), 'must not contain a query or fragment'),
      serviceName: text.optional(),
      timeoutMs: milliseconds.max(300_000).default(2000),
      resourceAttributes: filters.optional(),
      headers: z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/).refine(
        name => !/^(?:host|content-.*|transfer-encoding|connection|keep-alive|te|trailer|upgrade|expect|forwarded|x-forwarded-.*|x-original-url|x-rewrite-url)$/i.test(name),
        'must not override transport or payload headers',
      ), secret).optional(),
    }).strict(), config => {
      const provider = new OtlpObservabilityProvider({ ...config, fetch });
      return capability(provider, { observability: [provider] });
    }),
    'host.jumpserver': define('host.connection', z.object({ serverAlias: text.optional() }).strict(), config => ({ provider: {}, plugin: createJumpserverPlugin(config) })),
    'host.ssh': define('host.connection', z.object({
      hosts: z.array(z.object({ ...hostFields, username: text.optional(), port: port.optional(), identityFile: text.optional() }).strict()).min(1),
      username: text.optional(), port: port.optional(), identityFile: text.optional(), binary: text.optional(), scpBinary: text.optional(),
    }).strict(), config => host(createSshHostConnection({ ...config, identityFile: config.identityFile && path(config.identityFile), hosts: config.hosts.map(item => ({ ...item, identityFile: item.identityFile && path(item.identityFile) })), exec: options.hostExec }), 'ssh')),
    'host.aws-ssm': define('host.connection', z.object({
      hosts: z.array(z.object({ id: text.optional(), alias: text, instanceId: text, region: text.optional(), profile: text.optional(), address: text.optional() }).strict()).min(1),
      region: text.optional(), profile: text.optional(), binary: text.optional(), pollIntervalMs: milliseconds.optional(),
    }).strict(), config => host(createAwsSsmHostConnection({ ...config, exec: options.hostExec }), 'aws-ssm')),
    'host.kubernetes-exec': define('host.connection', z.object({
      hosts: z.array(z.object({ id: text.optional(), alias: text, pod: text, namespace: text.optional(), container: text.optional(), address: text.optional() }).strict()).min(1),
      namespace: text.optional(), context: text.optional(), kubeconfig: text.optional(), binary: text.optional(),
    }).strict(), config => host(createKubernetesExecHostConnection({ ...config, kubeconfig: config.kubeconfig && path(config.kubeconfig), exec: options.hostExec }), 'kubernetes-exec')),
    'sandbox.remote-container': defineOperation('sandbox.provider', secret => z.discriminatedUnion('transport', [
      z.object({ transport: z.literal('cli'), command: text, timeoutMs: milliseconds.optional() }).strict(),
      z.object({ transport: z.literal('http'), endpoint: baseUrl, token: secret.optional(), timeoutMs: milliseconds.optional() }).strict(),
    ]), config => {
      const transport = config.transport === 'cli'
        ? createRemoteContainerCliTransport({ command: config.command, timeoutMs: config.timeoutMs, run: options.remoteRun })
        : createRemoteContainerHttpTransport({ baseUrl: config.endpoint, token: config.token, timeoutMs: config.timeoutMs, fetch });
      const provider = new RemoteContainerSandboxProvider(transport);
      return direct(provider, 'sandbox.provider', context => context.registerSandboxProvider(provider.name, provider));
    }),
    'tracker.github': define(['tracker.provider', 'backlog.provider'], secret => z.object({ repo: text.refine(value => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value), 'must use owner/repository format'), token: secret }).strict(), config => tracker(new GitHubClient({ auth: config.token, repo: config.repo }))),
    'tracker.gitlab': define(['tracker.provider', 'backlog.provider'], secret => z.object({ url: baseUrl, token: secret, projectId: z.union([text, z.number().int().positive()]) }).strict(), config => tracker(new GitLabClient(config))),
    'tracker.linear': define('tracker.issue', secret => z.object({ baseUrl, token: secret, teamId: text }).strict(), config => {
      const provider = new LinearTrackerProvider({ ...config, fetch });
      return capability(provider, { issueTrackers: [provider] });
    }),
    'tracker.jira': define('tracker.issue', secret => z.object({ baseUrl, token: secret, projectKey: text, email: z.string().email().optional(), issueType: text.optional() }).strict(), config => {
      const provider = new JiraTrackerProvider({ ...config, fetch });
      return capability(provider, { issueTrackers: [provider] });
    }),
    'notification.feishu': defineOperation('notification.provider', secret => z.object({ webhook: secret.refine(value => typeof value !== 'string' || httpUrl.safeParse(value).success, 'invalid webhook configuration'), channel: text.optional() }).strict(), config => {
      const provider = new FeishuNotificationProvider({ ...config, fetch });
      return capability(provider, { notifications: [provider] });
    }),
    'notification.slack': defineOperation('notification.provider', secret => z.object({ webhook: secret.refine(value => typeof value !== 'string' || httpUrl.safeParse(value).success, 'invalid webhook configuration'), channel: text.optional() }).strict(), config => {
      const provider = new SlackNotificationProvider({ ...config, fetch });
      return capability(provider, { notifications: [provider] });
    }),
    'notification.email': define('notification.provider', z.object({ from: z.string().email(), to: z.string().email(), sendmailPath: text.optional(), channel: text.optional() }).strict(), config => {
      const provider = new EmailNotificationProvider({ ...config, executor: execute });
      return capability(provider, { notifications: [provider] });
    }),
    'notification.gmail': define('notification.provider', z.object({ to: z.string().email().optional(), channel: text.optional() }).strict(), config => ({
      ...direct({}, 'notification.provider', () => undefined),
      prepare: async context => {
        const credentials = context.getCredentialProvider('credential.google-oauth');
        if (!(credentials instanceof GoogleOAuthCredentialProvider)) throw new Error("credential provider 'credential.google-oauth' is not active or does not support Google accounts");
        const provider = new GmailNotificationProvider({ ...config, credentials, fetch: options.fetch });
        return capability(provider, { notifications: [provider] });
      },
    }), undefined, ['credential.google-oauth']),
    'notification.desktop': define('notification.provider', z.object({ platform: z.enum(['darwin', 'linux', 'win32']).optional(), channel: text.optional() }).strict(), config => {
      const provider = new DesktopNotificationProvider({ ...config, executor: execute });
      return capability(provider, { notifications: [provider] });
    }),
    'trigger.webhook': define('trigger.provider', secret => z.object({ secret, triggers: webhookDescriptors }).strict(), config => trigger(new WebhookTriggerProvider({ secret: config.secret, onEvent: (event, descriptor) => fire('trigger.webhook', descriptor, event) }), config.triggers)),
    'trigger.schedule': define('trigger.provider', z.object({ triggers: scheduleDescriptors }).strict(), config => trigger(new ScheduleTriggerProvider({ onFire: (trigger, tick) => options.onTrigger!({ pluginId: 'trigger.schedule', trigger, tick }) }), config.triggers)),
    'trigger.git-push': define('trigger.provider', z.object({ includeDeleted: z.boolean().optional(), triggers: webhookDescriptors }).strict(), config => trigger(new GitPushTriggerProvider({ includeDeleted: config.includeDeleted, onPush: (payload, descriptor) => fire('trigger.git-push', descriptor, payload) }), config.triggers)),
    'trigger.issue-event': define('trigger.provider', z.object({ triggers: webhookDescriptors }).strict(), config => trigger(new IssueEventTriggerProvider({ onIssue: (payload, descriptor) => fire('trigger.issue-event', descriptor, payload) }), config.triggers)),
    'learning.distiller': define('workflow.action', learningConfigurationSchema, config => ({ provider: {}, plugin: createLearningPlugin({ homeDir: options.homeDir, config }) }),
      config => config.knowledge ? [...learningPluginManifest.provides, 'context.provider'] : learningPluginManifest.provides),
    'context.experience': define('context.provider', z.object({}).strict(), () => {
      const homeDir = options.homeDir ?? homedir();
      const provider = new ExperienceContextProvider(experienceStorePath(homeDir), { homeDir, knowledge: options.knowledge });
      return capability(provider, { contexts: [provider] });
    }),
    'context.code': define('context.provider', z.object({ root: text }).strict(), config => {
      const provider = new CodeContextProvider({ root: path(config.root) });
      return capability(provider, { contexts: [provider] });
    }),
    'context.knowledge-base': defineOperation('context.provider', secret => z.object({ endpoint: httpUrl, token: secret.optional(), timeoutMs: milliseconds.max(300_000).optional() }).strict().refine(
      config => config.token === undefined || httpsUrl.safeParse(config.endpoint).success,
      { path: ['endpoint'], message: 'bearer token requires HTTPS' },
    ), config => {
      const provider = new KnowledgeBaseProvider({ ...config, fetch });
      return capability(provider, { contexts: [provider] });
    }),
    'context.retrieval': define('context.provider', z.object({ documents: z.array(z.object({ origin: text, content: text }).strict()).min(1) }).strict(), config => {
      const provider = new RetrievalProvider(config.documents);
      return capability(provider, { contexts: [provider] });
    }),
    'context.project-memory': define('context.provider', z.object({ file: text }).strict(), config => {
      const provider = new ProjectMemoryProvider({ file: path(config.file) });
      return capability(provider, { contexts: [provider] });
    }),
    'credential.system-keychain': define('credential.provider', z.object({ service: text, command: text.optional() }).strict(), config => {
      const provider = new SystemKeychainProvider({ ...config, execute });
      return capability(provider, { credentials: [provider] });
    }),
    'credential.google-oauth': define('credential.provider', z.object({}).strict(), () => {
      const provider = new GoogleOAuthCredentialProvider({ fetch: options.fetch, store: new OAuthKeychainStore(execute), homeDir: options.homeDir });
      return capability(provider, { credentials: [provider] });
    }),
    'credential.oauth': defineOperation('credential.provider', secret => z.object({ tokenEndpoint: httpsUrl, clientId: text, clientSecret: secret, authMethod: z.enum(['client_secret_basic', 'client_secret_post']).optional(), timeoutMs: milliseconds.optional() }).strict(), config => {
      const provider = new OAuthCredentialProvider({ ...config, fetch });
      return capability(provider, { credentials: [provider] });
    }),
    'credential.oidc': defineOperation('credential.provider', secret => z.object({
      issuer: baseUrl.refine(value => new URL(value).protocol === 'https:', 'must use HTTPS'), clientId: text, assertion: secret, tokenEndpoint: httpsUrl.optional(), timeoutMs: milliseconds.optional(),
      exchange: z.object({ subjectToken: secret, subjectTokenType: text, audience: text.optional(), resource: text.optional() }).strict().optional(),
    }).strict(), config => {
      return direct({}, 'credential.provider', context => {
        const { assertion, exchange, ...settings } = config;
        const provider = new OidcCredentialProvider({ ...settings, fetch,
          assertion: (_ref, _endpoint, operation) => typeof assertion === 'string' ? assertion : assertion(operation),
          exchange: exchange ? { ...exchange,
            subjectToken: (_ref, operation) => typeof exchange.subjectToken === 'string' ? exchange.subjectToken : exchange.subjectToken(operation),
          } : undefined,
        });
        context.onDispose(() => provider.dispose());
        context.registerCredentialProvider(provider.id, provider);
      });
    }),
    'credential.enterprise': defineOperation('credential.provider', secret => z.object({ values: z.record(secret).refine(values => Object.keys(values).length > 0, 'must contain credential references') }).strict(), config => {
      const provider = new EnterpriseCredentialProvider({ values: config.values, environment: {} });
      return capability(provider, { credentials: [provider] });
    }),
    'artifact.test-report-local': define('artifact.provider', z.object({ root: text }).strict(), config => {
      const provider = new TestReportProvider({ root: path(config.root) });
      return capability(provider, { artifacts: [provider] });
    }),
    'artifact.evidence-bundle': define('artifact.provider', z.object({ root: text }).strict(), config => {
      const bundle = new EvidenceBundleProvider(new TestReportProvider({ root: path(config.root) }));
      const provider: ArtifactSink & { create: EvidenceBundleProvider['create'] } = {
        id: bundle.id, capabilities: bundle.capabilities, create: bundle.create.bind(bundle),
        put: async (artifact, operation) => (await bundle.create({ name: artifact.name, records: [{ id: artifact.name, mediaType: artifact.mediaType, bytes: artifact.bytes }] }, operation)).ref,
      };
      return capability(provider, { artifacts: [provider] });
    }),
    'artifact.object-storage': define('artifact.provider', z.object({ endpoint: httpUrl }).strict(), config => {
      const provider = new ObjectStorageProvider({ ...config, transport: fetch });
      return capability(provider, { artifacts: [provider] });
    }),
    'artifact.report-platform': defineOperation('artifact.provider', secret => z.object({ endpoint: httpUrl, token: secret.optional() }).strict(), config => {
      const provider = new ReportPlatformProvider({ ...config, transport: fetch });
      return capability(provider, { artifacts: [provider] });
    }),
    'repository.multi-repository': define('repository.provider', z.object({
      repositories: z.array(z.object({ name: text, path: text, remoteUrl: text.optional(), baseBranch: text.optional(), leaseKey: text.optional() }).strict()).min(1).refine(items => new Set(items.map(item => item.name)).size === items.length, 'repository names must be unique'),
      managed: z.object({ workspaceRoot: text }).strict().optional(),
    }).strict(), config => {
      const provider = new MultiRepositoryProvider({ repositories: config.repositories.map(item => ({ ...item, path: path(item.path) })), git: execute,
        managed: config.managed && { workspaceRoot: path(config.managed.workspaceRoot) } });
      return capability(provider, { repositories: [provider] });
    }),
    'repository.remote-workspace': defineOperation('repository.provider', secret => z.object({ baseUrl, token: secret.optional(), lifecycle: repositoryLifecycle.optional(),
      managed: z.object({ workspaceRoot: text, repositories: z.array(z.object({ name: text, gitDirectory: text, leaseKey: text, remoteUrl: text }).strict()).min(1) }).strict().optional(),
    }).strict(), config => {
      const provider = new RemoteWorkspaceProvider({ ...config, transport: fetch, managed: config.managed && {
        workspaceRoot: path(config.managed.workspaceRoot), repositories: config.managed.repositories.map(repo => ({ ...repo, gitDirectory: path(repo.gitDirectory) })),
      } });
      return capability(provider, { repositories: [provider] });
    }),
    'repository.special-git-backend': define('repository.provider', z.object({ backend: text, lifecycle: repositoryLifecycle.optional() }).strict(), config => {
      const provider = new SpecialGitBackendProvider({ ...config, executor: execute });
      return capability(provider, { repositories: [provider] });
    }),
    'policy.secret-scan': define('policy.provider', z.object({ root: text, files: strings.optional(), maxFileBytes: z.number().int().positive().optional() }).strict(), config => {
      const provider = new SecretScanPolicyProvider({ ...config, root: path(config.root) });
      return capability(provider, { policies: [provider] });
    }),
    'policy.license-policy': define('policy.provider', z.object({ allowlist: strings, licenses: strings.optional() }).strict(), config => {
      const provider = new LicensePolicyProvider(config);
      return capability(provider, { policies: [provider] });
    }),
    'policy.compliance-policy': define('policy.provider', complianceSettings, config => {
      const provider = compliancePolicy(config);
      const evaluate = provider.evaluate.bind(provider);
      provider.evaluate = (input, operation) => {
        if (input.action !== 'tool.source.read' || !options.readToolSourcePolicy) return evaluate(input, operation);
        const current = complianceSettings.safeParse(options.readToolSourcePolicy());
        if (!current.success) return Promise.resolve({ allowed: false, rule: 'default-deny' });
        return compliancePolicy(current.data).evaluate(input, operation);
      };
      return capability(provider, { policies: [provider] });
    }),
    'verification.test-runner': define('verification.provider', commandConfig, config => {
      const provider = new TestRunnerVerificationProvider(config);
      return capability(provider, { verifications: [provider] });
    }),
    'verification.static-scan': define('verification.provider', commandConfig, config => {
      const provider = new StaticScanVerificationProvider(config);
      return capability(provider, { verifications: [provider] });
    }),
    'verification.browser-check': define('verification.provider', commandConfig, config => {
      const provider = new BrowserCheckVerificationProvider(config);
      return capability(provider, { verifications: [provider] });
    }),
  };
  const sandboxes = new SandboxProviderRegistry().registerBuiltins();
  for (const name of ['local', 'docker', 'podman'] as const) {
    definitions[`sandbox.${name}`] = define('sandbox.provider', z.object({ engine: z.literal(name).optional() }).strict(), () => {
      const deps = options.sandboxDeps ?? { worktreeManager: new WorktreeManager(options.workspaceRoot ?? process.cwd()) };
      const provider = sandboxes.create(name, deps);
      return direct(provider as ManagedProvider, 'sandbox.provider', context => context.registerSandboxProvider(name, provider));
    });
  }
  for (const name of ['claude-code', 'codex', 'cursor', 'pi', 'opencode', 'copilot'] as const) {
    definitions[`agent.${name}`] = define('agent.provider', z.object({}).strict(), () => {
      const agents = new AgentProviderRegistry();
      ensureBuiltinAgentProviders(agents);
      const provider = agents.require(name);
      return direct(provider, 'agent.provider', context => context.registerAgentProvider(name, provider));
    });
  }
  return { definitions, redact };
}

export async function createConfiguredPlugins(options: ConfiguredPluginsOptions): Promise<Plugin[]> {
  const { definitions, redact } = configuredDefinitions(options);
  const seen = new Set<string>();
  const dependencies = new Map<string, readonly string[]>();
  const plugins = options.configurations.map(configuration => {
    const { id } = configuration;
    if (seen.has(id)) throw new Error(`duplicate configured plugin '${id}'`);
    seen.add(id);
    if (!Object.hasOwn(definitions, id)) throw new Error(`unknown configured plugin '${id}'`);
    let prepared: PreparedPlugin;
    try { prepared = definitions[id].create(configuration.config ?? {}); }
    catch (error) { throw new Error(`plugin '${id}': ${redact(error instanceof Error ? error.message : 'invalid configuration')}`); }
    const { plugin, triggers } = prepared;
    const prepare = prepared.prepare;
    dependencies.set(id, prepared.dependencies ?? []);
    if (triggers) {
      if (!options.onTrigger) throw new Error(`plugin '${id}': onTrigger callback is required`);
      if (new Set(triggers.map(item => item.id)).size !== triggers.length) throw new Error(`plugin '${id}': trigger ids must be unique`);
    }
    const configured = {
      ...plugin,
      manifest: { ...plugin.manifest, id, externalTools: configuredExternalTools(id, configuration.config).declarations, ...(prepared.dependencies?.length && !plugin.manifest.provides.includes('credential.provider') ? { requires: [...new Set([...plugin.manifest.requires ?? [], 'credential.provider'])] } : {}) },
      async activate(context) {
        try {
          if (prepare) prepared = await prepare(context);
          await prepared.plugin.activate(context);
          if (options.activateTriggers === true) {
            for (const descriptor of prepared.triggers ?? []) await (prepared.provider as TriggerProvider).register(descriptor);
          }
        } catch (error) { throw new Error(`plugin '${id}': ${redact(error instanceof Error ? error.message : 'activation failed')}`); }
      },
      async health() {
        if (prepared.prepare) return { status: 'unknown', message: 'Provider is not activated' };
        const { plugin, provider } = prepared;
        try {
          const health = plugin.health ? await plugin.health() : provider.health ? await provider.health().then(result => ({
            status: result.status === 'ok' ? 'healthy' as const : result.status === 'unavailable' ? 'unhealthy' as const : 'degraded' as const,
            message: result.message,
          })) : { status: 'unknown' as const, message: 'Provider does not implement a health probe' };
          return { ...health, message: health.message && redact(health.message) };
        } catch { return { status: 'unhealthy', message: 'Provider health check failed' }; }
      },
      async diagnostics() {
        if (prepared.prepare) return [];
        const { plugin, provider } = prepared;
        try {
          const findings = plugin.diagnostics ? await plugin.diagnostics() : (await provider.doctor?.() ?? []).filter(result => !result.ok).map(result => ({
            severity: 'warning' as const, code: `provider.${result.check}`, message: result.detail ?? `Provider check '${result.check}' failed`,
          }));
          return findings.map(finding => ({ ...finding, code: redact(finding.code), message: redact(finding.message) }));
        } catch { return [{ severity: 'error', code: 'doctor.failed', message: 'Provider diagnostic check failed' }]; }
      },
    } satisfies Plugin;
    configuredCredentialDependencies.set(configured, prepared.dependencies ?? []);
    return configured;
  });
  const byId = new Map(plugins.map(plugin => [plugin.manifest.id, plugin]));
  const ordered: Plugin[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error('cyclic configured credential dependencies');
    visiting.add(id);
    for (const name of dependencies.get(id) ?? []) {
      if (byId.get(name)?.manifest.provides.includes('credential.provider')) visit(name);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(byId.get(id)!);
  };
  for (const plugin of plugins) visit(plugin.manifest.id);
  return ordered;
}
