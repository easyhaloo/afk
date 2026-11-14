import { join } from 'node:path';
import { z } from 'zod';
import type { ExternalToolDependency, PluginManifest, PluginConfigValue } from '../../plugin-sdk/profile.js';
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
import type { Plugin } from './runtime.js';
import { ExperienceContextProvider } from '../learning/runtime.js';
import { createLearningPlugin } from './learning.js';
import { verificationRequestSchema } from './operations.js';
import { configuredPluginManifests } from './configured.js';

const identifier = z.string().min(1);
export const capabilitySelectionSchema = z.object({
  policies: z.array(z.object({ provider: identifier, input: z.object({ action: identifier, context: z.record(z.union([z.string(), z.number(), z.boolean()])).optional() }).strict() }).strict()).default([]),
  verifications: z.array(verificationRequestSchema.omit({ target: true }).extend({ provider: identifier }).strict()).max(32).default([]),
  contexts: z.array(z.object({ provider: identifier, query: z.object({ scope: identifier, prompt: z.string(), limit: z.number().int().positive().optional() }).strict() }).strict()).default([]),
  artifacts: z.array(z.object({ provider: identifier, path: identifier, name: identifier, mediaType: identifier }).strict()).default([]),
  evidence: z.object({ provider: identifier, timeoutMs: z.number().int().positive().max(60_000).optional() }).strict().optional(),
  notifications: z.array(z.object({ provider: identifier, message: z.object({ title: identifier, body: z.string(), channel: z.string().optional(), urgency: z.enum(['low', 'normal', 'high']).optional() }).strict() }).strict()).default([]),
}).strict();

function defaultSelections(homeDir: string, workspaceRoot: string) {
  return [
    { ids: ['host.jumpserver'], create: () => [createJumpserverPlugin()] },
    { ids: ['host.ssh', 'host.aws-ssm', 'host.kubernetes-exec'], create: () => createHostPlugins() },
    { ids: configuredPluginManifests().filter(manifest => manifest.provides.includes('agent.provider')).map(manifest => manifest.id), create: () => createBuiltinAgentPlugins() },
    { ids: ['sandbox.local', 'sandbox.docker', 'sandbox.podman'], create: () => createBuiltinSandboxPlugins({ worktreeManager: new WorktreeManager(workspaceRoot) }) },
    { ids: ['verification.test-runner', 'verification.static-scan', 'verification.browser-check'], create: () => createBuiltinVerificationPlugins() },
    { ids: ['learning.distiller'], create: () => [createLearningPlugin({ homeDir })] },
    { ids: ['notification.desktop', 'context.experience', 'context.code', 'context.retrieval', 'context.project-memory',
        'credential.system-keychain', 'artifact.test-report-local', 'repository.multi-repository',
        'policy.secret-scan', 'policy.license-policy', 'policy.compliance-policy'],
      create: () => createBuiltinCapabilityPlugins({
        notifications: [new DesktopNotificationProvider()],
        contexts: [new ExperienceContextProvider(join(homeDir, '.afk', 'learning', 'experience.sqlite')),
          new CodeContextProvider({ root: workspaceRoot }), new RetrievalProvider([]),
          new ProjectMemoryProvider({ file: join(homeDir, '.afk', 'memory.json') })],
        credentials: [new SystemKeychainProvider()],
        artifacts: [new TestReportProvider({ root: join(homeDir, '.afk', 'artifacts') })],
        repositories: [new MultiRepositoryProvider({ repositories: [] })],
        policies: [new SecretScanPolicyProvider({ root: workspaceRoot }),
          new LicensePolicyProvider({ allowlist: ['mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc'] }),
          new CompliancePolicyProvider({ rules: [] })],
      }),
    },
  ];
}

export function createDefaultBuiltinProviderPlugins(homeDir: string, workspaceRoot: string): Plugin[] {
  return defaultSelections(homeDir, workspaceRoot).flatMap(selection => {
    const plugins = selection.create();
    if (JSON.stringify(plugins.map(plugin => plugin.manifest.id)) !== JSON.stringify(selection.ids)) throw new Error('Builtin metadata and factory selection disagree');
    return plugins.map(plugin => ({ ...plugin, manifest: withBuiltinExternalTools(plugin.manifest) }));
  });
}

export function builtinPluginManifests(homeDir: string, integrations?: unknown): readonly PluginManifest[] {
  if (integrations !== undefined && !capabilitySelectionSchema.safeParse(integrations).success) throw new Error('Invalid plugin integration configuration');
  const catalog = new Map(configuredPluginManifests().map(manifest => [manifest.id, manifest]));
  const manifests = defaultSelections(homeDir, process.cwd()).flatMap(selection => selection.ids.map(id => {
    const manifest = catalog.get(id);
    if (!manifest) throw new Error(`Builtin metadata is unavailable for '${id}'`);
    return manifest;
  })).concat({ id: 'workflow.capabilities', version: '0.1.0', apiVersion: 1, provides: ['workflow.action'], trusted: true });
  if (integrations !== undefined) manifests.push({ id: 'workflow.integrations', version: '0.1.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true });
  return manifests.map(withBuiltinExternalTools);
}

function withBuiltinExternalTools(manifest: PluginManifest): PluginManifest {
  const externalTools = builtinExternalTools(manifest.id);
  return externalTools.length ? { ...manifest, externalTools } : manifest;
}

export function builtinExternalTools(pluginId: string): readonly ExternalToolDependency[] {
  const tool = (id: string, command: string, location: 'host' | 'backend', url: string, args?: string[]): ExternalToolDependency => ({
    id, command, location, source: { url }, ...(args ? { version: { args } } : {}),
  });
  switch (pluginId) {
    case 'agent.claude-code': return [tool('claude-code', 'claude', 'backend', 'https://code.claude.com/docs/en/setup', ['--version'])];
    case 'agent.codex': return [tool('codex', 'codex', 'backend', 'https://github.com/openai/codex', ['--version'])];
    case 'agent.cursor': return [tool('cursor', 'cursor-agent', 'backend', 'https://cursor.com/docs/cli/installation', ['--version'])];
    case 'agent.pi': return [tool('pi', 'pi', 'backend', 'https://github.com/badlogic/pi-mono', ['--version'])];
    case 'agent.opencode': return [tool('opencode', 'opencode', 'backend', 'https://opencode.ai/docs/', ['--version'])];
    case 'agent.copilot': return [tool('copilot', 'copilot', 'backend', 'https://github.com/github/copilot-cli', ['--version'])];
    case 'host.ssh': return [
      tool('ssh', 'ssh', 'host', 'https://www.openssh.com/', ['-V']),
      tool('scp', 'scp', 'host', 'https://www.openssh.com/'),
    ];
    case 'host.jumpserver': return [tool('jms', 'jms', 'host', 'https://github.com/jumpserver/jms')];
    case 'host.aws-ssm': return [tool('aws', 'aws', 'host', 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html', ['--version'])];
    case 'host.kubernetes-exec': return [tool('kubectl', 'kubectl', 'host', 'https://kubernetes.io/docs/tasks/tools/', ['version', '--client', '--output=json'])];
    case 'sandbox.docker': return [tool('docker', 'docker', 'host', 'https://docs.docker.com/engine/install/', ['--version'])];
    case 'sandbox.podman': return [tool('podman', 'podman', 'host', 'https://podman.io/docs/installation', ['--version'])];
    case 'verification.browser-check': return [{ ...tool('playwright', 'playwright', 'backend', 'https://playwright.dev/docs/intro', ['--version']), optional: true }];
    default: return [];
  }
}


export interface UnsupportedToolBinding {
  readonly id: string;
  readonly command: string;
  readonly location: 'host' | 'backend';
  readonly status: 'unsupported';
  readonly reason: 'custom-binding';
}

export function configuredExternalTools(id: string, config: { readonly [key: string]: PluginConfigValue } = {}): {
  readonly declarations: readonly ExternalToolDependency[];
  readonly unsupported: readonly UnsupportedToolBinding[];
} {
  const bindings = new Map<string, string>();
  if (['host.ssh', 'host.aws-ssm', 'host.kubernetes-exec'].includes(id) && typeof config.binary === 'string') {
    const tool = builtinExternalTools(id)[0];
    if (config.binary !== tool.command) bindings.set(tool.id, config.binary);
  }
  if (id === 'host.ssh' && typeof config.scpBinary === 'string' && config.scpBinary !== 'scp') bindings.set('scp', config.scpBinary);
  if (id.startsWith('verification.') && Array.isArray(config.command)) bindings.set(id.slice('verification.'.length), String(config.command[0]));
  if (id === 'sandbox.remote-container' && config.transport === 'cli' && typeof config.command === 'string') bindings.set('remote-container', config.command);
  if (id === 'notification.email') bindings.set('sendmail', typeof config.sendmailPath === 'string' ? config.sendmailPath : '/usr/sbin/sendmail');
  if (id === 'credential.system-keychain' && typeof config.command === 'string') bindings.set('system-keychain', config.command);
  if (id === 'repository.special-git-backend' && typeof config.backend === 'string') bindings.set('special-git-backend', config.backend);
  const unsupported = [...bindings].map(([toolId, command]) => ({ id: toolId, command: command.trim(),
    location: id.startsWith('verification.') ? 'backend' as const : 'host' as const,
    status: 'unsupported' as const, reason: 'custom-binding' as const }));
  return { declarations: builtinExternalTools(id).filter(tool => !bindings.has(tool.id) && !(id.startsWith('verification.') && config.command !== undefined)), unsupported };
}
