import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { capabilitySelectionSchema as selectionSchema, createDefaultBuiltinProviderPlugins } from './builtin-manifests.js';
import { loadInstalledPlugins } from './loader.js';
import { PluginRuntime } from './runtime.js';
import { invokeCapability } from './operations.js';
import { createConfiguredPlugins } from './configured.js';
import { readPluginConfiguration, type PluginConfiguration } from './configuration.js';
import { createCapabilityLifecycle } from './integrations.js';
import type { ContextFragment } from '../../plugin-sdk/capabilities.js';
import { executeWorkItem } from '../workflows/execute-work-item.js';
import { assembleProviders } from '../../infrastructure/provider/assembly.js';
import { parseCanonicalProject, parseWorkItemId } from '../../domain/work-item/identity.js';
import { importManagedIssue, syncManagedIssue, managedIssueStateMapSchema } from './managed-issues.js';
import { CONTEXT_MAX_CHARS, writeReferenceContext } from '../workflows/context-file.js';
import { setPluginAuditArtifacts, setPluginAuditEvidence } from './observability.js';
import { createLocalEncryptedEvidenceStore } from '../../infrastructure/observability/local-evidence-store.js';
import { evidenceStoreSelectionSchema, type EvidenceMirrorOptions } from '../../infrastructure/observability/run-observer-factory.js';
import { currentTriggerDeliveryId } from './trigger-queue.js';

const identifier = z.string().min(1);

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
  let auditArtifacts: { provider: string; timeoutMs?: number } | undefined;
  let auditEvidence: ReturnType<typeof createLocalEncryptedEvidenceStore> | undefined;
  const initializeAuditEvidence = () => auditEvidence ??= createLocalEncryptedEvidenceStore(homeDir).catch(() => {
    auditEvidence = undefined;
    runtime.recordDiagnostic({ severity: 'error', code: 'config.evidence-invalid', message: 'Audit evidence storage could not be initialized; check the selected artifact provider and private local storage' });
    throw new Error('Audit evidence storage could not be initialized');
  });
  const localEvidence: EvidenceMirrorOptions['evidence'] = {
    async get(ref) { return (await initializeAuditEvidence()).get(ref); },
    async put(input) { return (await initializeAuditEvidence()).put(input); },
  };
  let configuration: PluginConfiguration;
  try { configuration = readPluginConfiguration(homeDir); }
  catch (error) {
    configuration = { plugins: [] };
    invalidSettings.push('Plugin configuration could not be validated');
    runtime.recordDiagnostic({ severity: 'error', code: 'config.invalid', message: error instanceof Error ? error.message : 'Invalid plugin configuration' });
  }
  const evidenceSelection = configuration.evidenceStore === undefined ? undefined : evidenceStoreSelectionSchema.safeParse(configuration.evidenceStore);
  if (evidenceSelection && !evidenceSelection.success) {
    invalidSettings.push('Evidence store selection could not be validated');
    runtime.recordDiagnostic({ severity: 'error', code: 'config.evidence-store-invalid', message: 'Evidence store selection could not be validated' });
  }
  const builtins: import('./runtime.js').Plugin[] = [
    {
      manifest: { id: 'workflow.capabilities', version: '0.1.0', apiVersion: 1 as const, provides: ['workflow.action'], trusted: true },
      activate(context: import('./runtime.js').PluginSetupContext) {
        context.registerSystemAction('work-item.import', async action => {
          const envelope = action && typeof action === 'object' && 'provider' in action ? action : (action as { input?: unknown } | null)?.input;
          const input = z.object({ provider: identifier, issueId: identifier, project: identifier, executionMode: z.enum(['afk', 'hitl']).optional() }).strict().parse(envelope);
          const project = parseCanonicalProject(input.project);
          const provider = runtime.getIssueTrackerProvider(input.provider);
          if (!provider) throw new Error('External issue tracker provider is not available');
          const { providers } = await assembleProviders({ platform: project.platform, projectKey: project.projectKey, cwd: workspaceRoot, plugins: runtime });
          return importManagedIssue({ ...input, provider, backlog: providers.backlog });
        });
        context.registerSystemAction('work-item.sync', async action => {
          const envelope = action && typeof action === 'object' && 'provider' in action ? action : (action as { input?: unknown } | null)?.input;
          const input = z.object({ provider: identifier, issueId: identifier, workItemId: identifier,
            states: managedIssueStateMapSchema,
          }).strict().parse(envelope);
          parseWorkItemId(input.workItemId);
          const provider = runtime.getIssueTrackerProvider(input.provider);
          if (!provider) throw new Error('External issue tracker provider is not available');
          const { providers } = await assembleProviders({ workItemId: input.workItemId, cwd: workspaceRoot, plugins: runtime });
          const item = await providers.backlog.get(input.workItemId);
          if (item.id !== input.workItemId) throw new Error('Managed issue identity conflicts with requested work item');
          return syncManagedIssue({ ...input, provider, item });
        });
        context.registerSystemAction('work-item.execute', async context => {
          const envelope = context && typeof context === 'object' && 'workItemId' in context ? context : (context as { input?: unknown } | null)?.input;
          const input = z.object({
            workItemId: identifier, manifestPath: identifier.optional(), executionId: identifier.optional(), template: identifier.optional(), project: identifier.optional(),
            runOptions: z.object({ executionMode: z.enum(['batch', 'interactive']).optional(), agentProvider: identifier.optional(), sandboxProvider: identifier.optional() }).strict().optional(),
          }).strict().parse(envelope);
          const deliveryId = currentTriggerDeliveryId();
          const executionId = input.executionId ?? (deliveryId && createHash('sha256').update(`${deliveryId}\0${input.workItemId}`).digest('hex'));
          const result = await executeWorkItem({ ...input, executionId }, { plugins: runtime, agentProviderRegistry: runtime.getAgentProviderRegistry() });
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
    ...createDefaultBuiltinProviderPlugins(homeDir, workspaceRoot),
  ];
  const overrides = new Set(configuration.plugins.filter(entry => entry.builtin && entry.config !== undefined).map(entry => entry.id));
  const plugins = builtins.filter(plugin => !overrides.has(plugin.manifest.id));
  const configured: PluginConfiguration['plugins'] = [];
  for (const entry of configuration.plugins) {
    if (!entry.builtin || entry.enabled === false || entry.config === undefined) continue;
    try {
      if (entry.id.startsWith('trigger.') && options.activateTriggers && (typeof entry.action !== 'string' || !entry.action.trim())) throw new Error('Trigger action must be configured before activating triggers');
      await createConfiguredPlugins({ configurations: [entry], homeDir, workspaceRoot, onTrigger: async () => {} });
      configured.push(entry);
    } catch (error) {
      invalidSettings.push(`Plugin ${entry.id} could not be configured`);
      runtime.recordDiagnostic({ pluginId: entry.id, severity: 'error', code: 'config.provider-invalid', message: error instanceof Error ? error.message : 'Invalid provider settings' });
    }
  }
  try {
    plugins.push(...await createConfiguredPlugins({
      configurations: configured, homeDir, workspaceRoot, activateTriggers: options.activateTriggers,
      onTrigger: async event => {
        const entry = configured.find(candidate => candidate.id === event.pluginId);
        if (typeof entry?.action !== 'string') throw new Error('Trigger action is not configured');
        try { await runtime.dispatchSystemAction(entry.action, event.trigger.input ?? event.payload ?? event.trigger.payload ?? {}); }
        catch {
          runtime.recordDiagnostic({ pluginId: entry.id, severity: 'error', code: 'trigger.action-failed', message: 'Configured trigger action failed' });
          options.warn?.(`Trigger action failed for ${entry.id}`);
          throw new Error('Configured trigger action failed');
        }
      },
    }));
  } catch (error) {
    invalidSettings.push('Configured plugin dependencies could not be resolved');
    runtime.recordDiagnostic({ severity: 'error', code: 'config.provider-invalid', message: error instanceof Error ? error.message : 'Invalid provider dependencies' });
  }
  if (configuration.integrations !== undefined) {
    const parsed = selectionSchema.safeParse(configuration.integrations);
    if (!parsed.success) {
      invalidSettings.push('Capability lifecycle selections could not be validated');
      runtime.recordDiagnostic({ severity: 'error', code: 'config.integrations-invalid', message: 'Invalid capability lifecycle selections' });
    }
    else {
      const selection = parsed.data;
      auditArtifacts = selection.evidence;
      const fragments = new Map<string, ContextFragment[]>();
      const module = createCapabilityLifecycle(runtime, {
        policies: selection.policies.map(policy => ({ ...policy, input: context => ({ ...policy.input, context: { ...policy.input.context, worktreePath: context.worktreePath } }) })),
        contexts: selection.contexts.map(source => ({
          ...source, query: () => source.query,
          async consume(received, context) {
            const merged = [...(fragments.get(context.worktreePath) ?? []), ...received].slice(0, 64)
              .map(fragment => ({ ...fragment, origin: fragment.origin.slice(0, 1000), content: fragment.content.slice(0, CONTEXT_MAX_CHARS) }));
            fragments.set(context.worktreePath, merged);
            await writeReferenceContext(context.worktreePath, 'plugin-context.md', merged);
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
            async onInit(context) {
              await module.onInit?.(context);
              if (auditArtifacts) await initializeAuditEvidence();
            },
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
  await loadInstalledPlugins(runtime, { ...options, homeDir, workspaceRoot, entries: configuration.plugins, plugins });
  if (auditArtifacts) {
    try {
      setPluginAuditArtifacts(runtime, { ...auditArtifacts, evidence: localEvidence, captureEvents: true });
    } catch {
      invalidSettings.push('Audit evidence storage could not be initialized');
      runtime.recordDiagnostic({ severity: 'error', code: 'config.evidence-invalid', message: 'Audit evidence storage could not be initialized; check the selected artifact provider and private local storage' });
    }
  }
  if (evidenceSelection?.success) {
    try {
      let reported = false;
      setPluginAuditEvidence(runtime, { ...evidenceSelection.data, evidence: localEvidence,
        onFailure() {
          if (reported) return;
          reported = true;
          runtime.recordDiagnostic({ severity: 'warning', code: 'evidence.mirror-failed', message: 'Evidence mirroring failed; local audit remains authoritative' });
        },
      });
    } catch {
      invalidSettings.push('Evidence store selection is unavailable');
      runtime.recordDiagnostic({ severity: 'error', code: 'config.evidence-store-invalid', message: 'Evidence store selection is unavailable' });
    }
  }
  if (invalidSettings.length) await runtime.activate({
    manifest: { id: 'workflow.invalid-settings', version: '0.1.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true },
    activate(context) {
      context.registerLifecycle({ name: 'invalid-plugin-settings', order: -1000, failureMode: 'required', async onInit() { throw new Error(invalidSettings.join('; ')); } });
    },
  });
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
