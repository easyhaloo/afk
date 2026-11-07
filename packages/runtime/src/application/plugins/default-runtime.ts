import { homedir } from 'node:os';
import { constants, promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WorktreeManager } from '../../infrastructure/git/worktree.js';
import {
  CodeContextProvider, CompliancePolicyProvider, DesktopNotificationProvider,
  LicensePolicyProvider, MultiRepositoryProvider, ProjectMemoryProvider,
  RetrievalProvider, SecretScanPolicyProvider, SystemKeychainProvider, TestReportProvider,
} from '../../infrastructure/providers/index.js';
import { createHostPlugins } from './builtins-host.js';
import { createJumpserverPlugin } from './builtins.js';
import { createBuiltinAgentPlugins, createBuiltinSandboxPlugins, createBuiltinVerificationPlugins } from './builtin-providers.js';
import { createBuiltinCapabilityPlugins } from './builtin-capabilities.js';
import { loadInstalledPlugins } from './loader.js';
import { PluginRuntime } from './runtime.js';
import { invokeCapability } from './operations.js';
import { createConfiguredPlugins } from './configured.js';
import { readPluginConfiguration, type PluginConfiguration } from './configuration.js';
import { createCapabilityLifecycle } from './integrations.js';
import type { ContextFragment } from '../../plugin-sdk/capabilities.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';

const identifier = z.string().min(1);
const selectionSchema = z.object({
  policies: z.array(z.object({ provider: identifier, input: z.object({ action: identifier, context: z.record(z.union([z.string(), z.number(), z.boolean()])).optional() }).strict() }).strict()).default([]),
  contexts: z.array(z.object({ provider: identifier, query: z.object({ scope: identifier, prompt: z.string(), limit: z.number().int().positive().optional() }).strict() }).strict()).default([]),
  artifacts: z.array(z.object({ provider: identifier, path: identifier, name: identifier, mediaType: identifier }).strict()).default([]),
  notifications: z.array(z.object({ provider: identifier, message: z.object({ title: identifier, body: z.string(), channel: z.string().optional(), urgency: z.enum(['low', 'normal', 'high']).optional() }).strict() }).strict()).default([]),
}).strict();

export interface DefaultPluginRuntimeOptions {
  readonly homeDir?: string;
  readonly workspaceRoot?: string;
  readonly warn?: (message: string, error?: unknown) => void;
  readonly activateTriggers?: boolean;
}

export async function createDefaultPluginRuntime(options: DefaultPluginRuntimeOptions = {}): Promise<PluginRuntime> {
  const homeDir = options.homeDir ?? homedir();
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const runtime = new PluginRuntime();
  const invalidSettings: string[] = [];
  let configuration: PluginConfiguration;
  try { configuration = readPluginConfiguration(homeDir); }
  catch (error) {
    configuration = { plugins: [] };
    invalidSettings.push('Plugin configuration could not be validated');
    runtime.recordDiagnostic({ severity: 'error', code: 'config.invalid', message: error instanceof Error ? error.message : 'Invalid plugin configuration' });
  }
  const builtins: import('./runtime.js').Plugin[] = [
    {
      manifest: { id: 'workflow.capabilities', version: '0.1.0', apiVersion: 1 as const, provides: ['workflow.action'], trusted: true },
      activate(context: import('./runtime.js').PluginSetupContext) {
        context.registerSystemAction('work-item.execute', async context => {
          const envelope = context && typeof context === 'object' && 'workItemId' in context ? context : (context as { input?: unknown } | null)?.input;
          const input = z.object({
            workItemId: identifier, manifestPath: identifier.optional(), executionId: identifier.optional(), template: identifier.optional(), project: identifier.optional(),
            runOptions: z.object({ executionMode: z.enum(['batch', 'interactive']).optional(), agentProvider: identifier.optional(), sandboxProvider: identifier.optional() }).strict().optional(),
          }).strict().parse(envelope);
          const result = await executeWorkItem(input, { plugins: runtime, agentProviderRegistry: runtime.getAgentProviderRegistry() });
          if (result.status !== 'done' && result.status !== 'merge_ready') throw new Error(`Managed execution stopped: ${result.status}`);
          return result;
        });
        context.registerSystemAction('capability.invoke', async context => {
          const envelope = context && typeof context === 'object' ? context as { input?: unknown; worktreePath?: string } : undefined;
          let input = context && typeof context === 'object' && 'capability' in context ? context : envelope?.input ?? context;
          if (input && typeof input === 'object' && 'capability' in input && input.capability === 'verification.provider' && envelope?.worktreePath) {
            const request = input as { capability: string; input?: { target?: string } };
            input = { ...request, input: { target: envelope.worktreePath, ...request.input } };
          }
          const result = await invokeCapability(runtime, input);
          if (result && typeof result === 'object' && (
            ('passed' in result && result.passed === false) || ('allowed' in result && result.allowed === false)
            || ('delivered' in result && result.delivered === false) || ('code' in result && typeof result.code === 'number' && result.code !== 0)
          )) throw new Error('Capability operation failed its required check');
          return result;
        });
      },
    },
    createJumpserverPlugin(), ...createHostPlugins(), ...createBuiltinAgentPlugins(),
    ...createBuiltinSandboxPlugins({ worktreeManager: new WorktreeManager(workspaceRoot) }),
    ...createBuiltinVerificationPlugins(),
    ...createBuiltinCapabilityPlugins({
      notifications: [new DesktopNotificationProvider()],
      contexts: [
        new CodeContextProvider({ root: workspaceRoot }), new RetrievalProvider([]),
        new ProjectMemoryProvider({ file: join(homeDir, '.afk', 'memory.json') }),
      ],
      credentials: [new SystemKeychainProvider()],
      artifacts: [new TestReportProvider({ root: join(homeDir, '.afk', 'artifacts') })],
      repositories: [new MultiRepositoryProvider({ repositories: [] })],
      policies: [
        new SecretScanPolicyProvider({ root: workspaceRoot }),
        new LicensePolicyProvider({ allowlist: ['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc'] }),
        new CompliancePolicyProvider({ rules: [] }),
      ],
    }),
  ];
  const overrides = new Set(configuration.plugins.filter(entry => entry.builtin && entry.config !== undefined).map(entry => entry.id));
  const plugins = builtins.filter(plugin => !overrides.has(plugin.manifest.id));
  for (const entry of configuration.plugins) {
    if (!entry.builtin || entry.enabled === false || entry.config === undefined) continue;
    try {
      if (entry.id.startsWith('trigger.') && options.activateTriggers && (typeof entry.action !== 'string' || !entry.action.trim())) throw new Error('Trigger action must be configured before activating triggers');
      plugins.push(...await createConfiguredPlugins({
        configurations: [entry], homeDir, workspaceRoot, activateTriggers: options.activateTriggers,
        onTrigger: async event => {
          if (typeof entry.action !== 'string') throw new Error('Trigger action is not configured');
          try { await runtime.dispatchSystemAction(entry.action, event.trigger.input ?? event.payload ?? event.trigger.payload ?? {}); }
          catch {
            runtime.recordDiagnostic({ pluginId: entry.id, severity: 'error', code: 'trigger.action-failed', message: 'Configured trigger action failed' });
            options.warn?.(`Trigger action failed for ${entry.id}`);
            throw new Error('Configured trigger action failed');
          }
        },
      }));
    } catch (error) {
      invalidSettings.push(`Plugin ${entry.id} could not be configured`);
      runtime.recordDiagnostic({ pluginId: entry.id, severity: 'error', code: 'config.provider-invalid', message: error instanceof Error ? error.message : 'Invalid provider settings' });
    }
  }
  if (configuration.integrations !== undefined) {
    const parsed = selectionSchema.safeParse(configuration.integrations);
    if (!parsed.success) {
      invalidSettings.push('Capability lifecycle selections could not be validated');
      runtime.recordDiagnostic({ severity: 'error', code: 'config.integrations-invalid', message: 'Invalid capability lifecycle selections' });
    }
    else {
      const selection = parsed.data;
      const fragments = new Map<string, ContextFragment[]>();
      const module = createCapabilityLifecycle(runtime, {
        policies: selection.policies.map(policy => ({ ...policy, input: context => ({ ...policy.input, context: { ...policy.input.context, worktreePath: context.worktreePath } }) })),
        contexts: selection.contexts.map(source => ({
          ...source, query: () => source.query,
          async consume(received, context) {
            const merged = [...(fragments.get(context.worktreePath) ?? []), ...received];
            fragments.set(context.worktreePath, merged);
            const root = await fs.realpath(context.worktreePath);
            const directory = join(root, '.afk');
            await fs.mkdir(directory, { recursive: true });
            if (await fs.realpath(directory) !== directory) throw new Error('Plugin context directory must not be a symbolic link');
            const temporary = join(directory, `plugin-context-${randomUUID()}.tmp`);
            try {
              await fs.writeFile(temporary, merged.map(fragment => `Source: ${fragment.origin}\n\n${fragment.content}`).join('\n\n---\n\n'), { flag: 'wx', mode: 0o600 });
              await fs.rename(temporary, join(directory, 'plugin-context.md'));
            } finally { await fs.rm(temporary, { force: true }); }
          },
        })),
        artifacts: selection.artifacts.map(artifact => ({
          provider: artifact.provider,
          async artifact(context) {
            const root = await fs.realpath(context.worktreePath);
            const path = await fs.realpath(resolve(root, artifact.path));
            const suffix = relative(root, path);
            if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('Artifact path escapes the execution worktree');
            const stat = await fs.stat(path);
            if (!stat.isFile() || stat.size > 16 * 1024 * 1024) throw new Error('Artifact must be a file smaller than 16MiB');
            return { name: artifact.name, mediaType: artifact.mediaType, bytes: await fs.readFile(path) };
          },
          async publish(ref, context) {
            const directory = join(context.worktreePath, '.afk');
            await fs.mkdir(directory, { recursive: true });
            if (await fs.realpath(directory) !== join(await fs.realpath(context.worktreePath), '.afk')) throw new Error('Artifact reference directory must not be a symbolic link');
            const file = join(directory, 'published-artifacts.jsonl');
            const previous = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
            if (previous?.isSymbolicLink()) throw new Error('Artifact reference file must not be a symbolic link');
            const handle = await fs.open(file, constants.O_APPEND | constants.O_WRONLY | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
            try { await handle.write(`${JSON.stringify(ref)}\n`); }
            finally { await handle.close(); }
          },
        })),
        notifications: selection.notifications.map(notification => ({ ...notification, message: (_context, artifacts) => ({ ...notification.message, body: [notification.message.body, ...artifacts.map(artifact => artifact.artifact.uri)].join('\n') }) })),
      });
      plugins.push({
        manifest: { id: 'workflow.integrations', version: '0.1.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true },
        activate(context) {
          context.registerLifecycle({
            ...module,
            async onBeforeAgent(context) { fragments.delete(context.worktreePath); await module.onBeforeAgent?.(context); },
            async onCleanup(context) {
              if (fragments.has(context.worktreePath)) {
                const root = await fs.realpath(context.worktreePath);
                const directory = join(root, '.afk');
                if (await fs.realpath(directory) !== directory) throw new Error('Plugin context directory must not be a symbolic link');
                await fs.rm(join(directory, 'plugin-context.md'), { force: true });
              }
              fragments.delete(context.worktreePath);
            },
          });
          context.onDispose(() => fragments.clear());
        },
      });
    }
  }
  if (invalidSettings.length) plugins.push({
    manifest: { id: 'workflow.invalid-settings', version: '0.1.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true },
    activate(context) {
      context.registerLifecycle({ name: 'invalid-plugin-settings', order: -1000, failureMode: 'required', async onInit() { throw new Error(invalidSettings.join('; ')); } });
    },
  });
  await loadInstalledPlugins(runtime, { ...options, homeDir, workspaceRoot, entries: configuration.plugins, plugins });
  if (options.activateTriggers) {
    for (const entry of configuration.plugins) {
      if (!entry.builtin || entry.enabled === false || !entry.id.startsWith('trigger.') || !runtime.getPlugin(entry.id)) continue;
      if (typeof entry.action === 'string' && runtime.listSystemActions().includes(entry.action)) continue;
      await runtime.dispose(entry.id);
      runtime.recordDiagnostic({ pluginId: entry.id, severity: 'error', code: 'trigger.action-missing', message: 'Configured trigger action is not registered' });
    }
  }
  return runtime;
}
