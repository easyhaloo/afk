import { join } from 'node:path';
import { z } from 'zod';
import type { PluginManifest } from '../../plugin-sdk/profile.js';
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

const identifier = z.string().min(1);
export const capabilitySelectionSchema = z.object({
  policies: z.array(z.object({ provider: identifier, input: z.object({ action: identifier, context: z.record(z.union([z.string(), z.number(), z.boolean()])).optional() }).strict() }).strict()).default([]),
  contexts: z.array(z.object({ provider: identifier, query: z.object({ scope: identifier, prompt: z.string(), limit: z.number().int().positive().optional() }).strict() }).strict()).default([]),
  artifacts: z.array(z.object({ provider: identifier, path: identifier, name: identifier, mediaType: identifier }).strict()).default([]),
  notifications: z.array(z.object({ provider: identifier, message: z.object({ title: identifier, body: z.string(), channel: z.string().optional(), urgency: z.enum(['low', 'normal', 'high']).optional() }).strict() }).strict()).default([]),
}).strict();

export function createDefaultBuiltinProviderPlugins(homeDir: string, workspaceRoot: string): Plugin[] {
  return [
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
}

export function builtinPluginManifests(homeDir: string, integrations?: unknown): readonly PluginManifest[] {
  if (integrations !== undefined && !capabilitySelectionSchema.safeParse(integrations).success) throw new Error('Invalid plugin integration configuration');
  const manifests = createDefaultBuiltinProviderPlugins(homeDir, process.cwd()).map(plugin => plugin.manifest)
    .concat({ id: 'workflow.capabilities', version: '0.1.0', apiVersion: 1, provides: ['workflow.action'], trusted: true });
  if (integrations !== undefined) manifests.push({ id: 'workflow.integrations', version: '0.1.0', apiVersion: 1, provides: ['workflow.lifecycle'], trusted: true });
  return manifests;
}
