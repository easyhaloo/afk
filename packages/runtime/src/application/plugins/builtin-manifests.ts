import { join } from 'node:path';
import { z } from 'zod';
import type { ExternalToolDependency, PluginManifest } from '../../plugin-sdk/profile.js';
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

const identifier = z.string().min(1);
export const capabilitySelectionSchema = z.object({
  policies: z.array(z.object({ provider: identifier, input: z.object({ action: identifier, context: z.record(z.union([z.string(), z.number(), z.boolean()])).optional() }).strict() }).strict()).default([]),
  verifications: z.array(verificationRequestSchema.omit({ target: true }).extend({ provider: identifier }).strict()).max(32).default([]),
  contexts: z.array(z.object({ provider: identifier, query: z.object({ scope: identifier, prompt: z.string(), limit: z.number().int().positive().optional() }).strict() }).strict()).default([]),
  artifacts: z.array(z.object({ provider: identifier, path: identifier, name: identifier, mediaType: identifier }).strict()).default([]),
  evidence: z.object({ provider: identifier, timeoutMs: z.number().int().positive().max(60_000).optional() }).strict().optional(),
  notifications: z.array(z.object({ provider: identifier, message: z.object({ title: identifier, body: z.string(), channel: z.string().optional(), urgency: z.enum(['low', 'normal', 'high']).optional() }).strict() }).strict()).default([]),
}).strict();

export function createDefaultBuiltinProviderPlugins(homeDir: string, workspaceRoot: string): Plugin[] {
  return [
    createJumpserverPlugin(), ...createHostPlugins(), ...createBuiltinAgentPlugins(),
    ...createBuiltinSandboxPlugins({ worktreeManager: new WorktreeManager(workspaceRoot) }),
    ...createBuiltinVerificationPlugins(),
    createLearningPlugin({ homeDir }),
    ...createBuiltinCapabilityPlugins({
      notifications: [new DesktopNotificationProvider()],
      contexts: [
        new ExperienceContextProvider(join(homeDir, '.afk', 'learning', 'experience.sqlite')),
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
  ].map(plugin => {
    const externalTools = builtinExternalTools(plugin.manifest.id);
    return externalTools.length ? { ...plugin, manifest: { ...plugin.manifest, externalTools } } : plugin;
  });
}

export function builtinPluginManifests(homeDir: string, integrations?: unknown): readonly PluginManifest[] {
  if (integrations !== undefined && !capabilitySelectionSchema.safeParse(integrations).success) throw new Error('Invalid plugin integration configuration');
  const manifests = createDefaultBuiltinProviderPlugins(homeDir, process.cwd()).map(plugin => plugin.manifest)
    .concat({ id: 'workflow.capabilities', version: '0.1.0', apiVersion: 1, provides: ['workflow.action'], trusted: true });
  if (integrations !== undefined) manifests.push({ id: 'workflow.integrations', version: '0.1.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true });
  return manifests;
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
