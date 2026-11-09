/**
 * Agent providers — registry and factory.
 */
import {
  AgentProviderRegistry,
  defaultAgentProviderRegistry,
  getAgentProvider,
  registerAgentProvider,
  requireAgentProvider,
} from './registry.js';
import type { AgentProvider, AgentProviderName } from './types.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { CodexProvider } from './codex.js';
import { CursorProvider } from './cursor.js';
import { PiProvider } from './pi.js';
import { OpenCodeProvider } from './opencode.js';
import { CopilotProvider } from './copilot.js';
export {
  AgentProviderRegistry,
  defaultAgentProviderRegistry,
  registerAgentProvider,
  getAgentProvider,
  requireAgentProvider,
  listAgentProviders,
  _resetAgentRegistry,
  guardedRestoreSession,
  guardedCaptureSession,
} from './registry.js';
export { ProcessAgentProvider } from './process-provider.js';
export { DEFAULT_CODEX_CONFIG, prepareAgentRuntime, probeCodexReadiness, resolveCodexRuntime } from './codex-runtime.js';
export { resolveRuntimeForProvider } from './runtime-binding.js';
export type { RuntimeForProviderInput } from './runtime-binding.js';
export type { CodexAuth, CodexConfig, CodexDoctorRunner, CodexEndpointProbe, CodexHostDiagnostics, CodexReadiness, CodexReadinessProbe, CodexRuntimeOverrides, CodexTransport } from './codex-runtime.js';
export type { AgentProvider, AgentProviderName, AgentCapability, AgentCommand, AgentEvent, AgentSession, TokenUsage, SessionSnapshot, AgentCommandOptions, AgentExecutionMetadata, AgentExecutionOptions, AgentRuntimeSelection, CodexRuntimeSelection, CaptureSessionOptions, RestoreSessionOptions } from './types.js';

/** Register all bundled providers on demand. Safe after test registry resets. */
export function ensureBuiltinAgentProviders(registry: AgentProviderRegistry = defaultAgentProviderRegistry): void {
  if (!registry.get('claude-code')) {
    registry.register(new ClaudeCodeProvider());
  }
  if (!registry.get('codex')) {
    registry.register(new CodexProvider());
  }
  if (!registry.get('cursor')) {
    registry.register(new CursorProvider());
  }
  if (!registry.get('pi')) {
    registry.register(new PiProvider());
  }
  if (!registry.get('opencode')) {
    registry.register(new OpenCodeProvider());
  }
  if (!registry.get('copilot')) {
    registry.register(new CopilotProvider());
  }
}

/**
 * Factory: resolve an AgentProviderName to a registered AgentProvider instance.
 * All provider-internal assembly is encapsulated here — callers only get
 * the ready-to-use provider. The default is 'claude-code'.
 */
export function createAgentProvider(
  name: AgentProviderName = 'claude-code',
  registry: AgentProviderRegistry = defaultAgentProviderRegistry,
): AgentProvider {
  if (registry === defaultAgentProviderRegistry) ensureBuiltinAgentProviders(registry);
  return registry.require(name);
}

/** Validate an untyped config or CLI value against the provider registry. */
export function resolveAgentProviderName(
  raw: string = 'claude-code',
  registry: AgentProviderRegistry = defaultAgentProviderRegistry,
): AgentProviderName {
  if (registry === defaultAgentProviderRegistry) ensureBuiltinAgentProviders(registry);
  return registry.require(raw).name;
}
