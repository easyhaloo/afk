import type { Plugin, PluginHealth } from './runtime.js';
import { AgentProviderRegistry, ensureBuiltinAgentProviders } from '../../domain/agents/index.js';
import { SandboxProviderRegistry, type SandboxProviderDeps } from '../../infrastructure/sandbox/registry.js';
import type { CommandVerificationOptions } from '../../infrastructure/verification/index.js';
import {
  BrowserCheckVerificationProvider,
  StaticScanVerificationProvider,
  TestRunnerVerificationProvider,
} from '../../infrastructure/verification/index.js';
import type { VerificationProvider } from '../../plugin-sdk/capabilities.js';
import type { RemoteContainerSandboxProvider } from '../../infrastructure/sandbox/remote-container.js';

export function createBuiltinAgentPlugins(): Plugin[] {
  const registry = new AgentProviderRegistry();
  ensureBuiltinAgentProviders(registry);
  return registry.list().map(provider => ({
    manifest: { id: `agent.${provider.name}`, version: '0.1.0', apiVersion: 1, provides: ['agent.provider'], trusted: true },
    activate: context => context.registerAgentProvider(provider.name, provider),
  }));
}

export function createBuiltinSandboxPlugins(deps: SandboxProviderDeps): Plugin[] {
  const registry = new SandboxProviderRegistry().registerBuiltins();
  return registry.list().map(metadata => ({
    manifest: { id: `sandbox.${metadata.id}`, version: '0.1.0', apiVersion: 1, provides: ['sandbox.provider'], trusted: true },
    activate: context => context.registerSandboxProvider(metadata.id, registry.create(metadata.id, deps)),
    async health(): Promise<PluginHealth> {
      const status = await metadata.health();
      return { status: status === 'ready' ? 'healthy' : status === 'unavailable' ? 'unhealthy' : status };
    },
  }));
}

export interface BuiltinVerificationOptions {
  readonly testRunner?: CommandVerificationOptions;
  readonly staticScan?: CommandVerificationOptions;
  readonly browserCheck?: CommandVerificationOptions;
}

export function createBuiltinVerificationPlugins(options: BuiltinVerificationOptions = {}): Plugin[] {
  const providers: VerificationProvider[] = [
    new TestRunnerVerificationProvider(options.testRunner),
    new StaticScanVerificationProvider(options.staticScan),
    new BrowserCheckVerificationProvider(options.browserCheck),
  ];
  return providers.map(provider => ({
    manifest: { id: `verification.${provider.id}`, version: '0.1.0', apiVersion: 1, provides: ['verification.provider'], trusted: true },
    activate: context => context.registerVerificationProvider(provider.id, provider),
  }));
}

export function createRemoteContainerPlugin(provider: RemoteContainerSandboxProvider): Plugin {
  return {
    manifest: { id: 'sandbox.remote-container', version: '0.1.0', apiVersion: 1, provides: ['sandbox.provider'], trusted: true },
    activate: context => context.registerSandboxProvider(provider.name, provider),
    health: async () => ({ status: (await providerHealth(provider)) ? 'healthy' as const : 'degraded' as const }),
  };
}

async function providerHealth(provider: RemoteContainerSandboxProvider): Promise<boolean> {
  const transport = (provider as unknown as { transport?: { health?: () => Promise<boolean> } }).transport;
  return transport?.health ? transport.health() : true;
}
