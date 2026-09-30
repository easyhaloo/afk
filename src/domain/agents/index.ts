/**
 * Agent providers — registry and factory.
 */
import { requireAgentProvider, getAgentProvider, registerAgentProvider } from './registry.js';
import type { AgentProvider, AgentProviderName } from './types.js';
import { ClaudeCodeProvider } from './claude-code.js';
import { CodexProvider } from './codex.js';
import { CursorProvider } from './cursor.js';
import { PiProvider } from './pi.js';
import { OpenCodeProvider } from './opencode.js';
import { CopilotProvider } from './copilot.js';
export { registerAgentProvider, getAgentProvider, requireAgentProvider } from './registry.js';
export { ProcessAgentProvider } from './process-provider.js';
export { DEFAULT_CODEX_CONFIG, prepareAgentRuntime, probeCodexReadiness, resolveCodexRuntime } from './codex-runtime.js';
export type { CodexAuth, CodexConfig, CodexDoctorRunner, CodexEndpointProbe, CodexHostDiagnostics, CodexReadiness, CodexReadinessProbe, CodexRuntimeOverrides, CodexTransport } from './codex-runtime.js';
export type { AgentProvider, AgentProviderName, AgentCapability, AgentCommand, AgentEvent, AgentSession, TokenUsage, SessionSnapshot, AgentCommandOptions, AgentExecutionMetadata, AgentExecutionOptions, AgentRuntimeSelection, CodexRuntimeSelection, CaptureSessionOptions, RestoreSessionOptions } from './types.js';

/** Register all bundled providers on demand. Safe after test registry resets. */
export function ensureBuiltinAgentProviders(): void {
  if (!getAgentProvider('claude-code')) {
    registerAgentProvider(new ClaudeCodeProvider());
  }
  if (!getAgentProvider('codex')) {
    registerAgentProvider(new CodexProvider());
  }
  if (!getAgentProvider('cursor')) {
    registerAgentProvider(new CursorProvider());
  }
  if (!getAgentProvider('pi')) {
    registerAgentProvider(new PiProvider());
  }
  if (!getAgentProvider('opencode')) {
    registerAgentProvider(new OpenCodeProvider());
  }
  if (!getAgentProvider('copilot')) {
    registerAgentProvider(new CopilotProvider());
  }
}

/**
 * Factory: resolve an AgentProviderName to a registered AgentProvider instance.
 * All provider-internal assembly is encapsulated here — callers only get
 * the ready-to-use provider. The default is 'claude-code'.
 */
export function createAgentProvider(name: AgentProviderName = 'claude-code'): AgentProvider {
  ensureBuiltinAgentProviders();
  return requireAgentProvider(name);
}

/** Validate an untyped config or CLI value against the provider registry. */
export function resolveAgentProviderName(raw: string = 'claude-code'): AgentProviderName {
  ensureBuiltinAgentProviders();
  requireAgentProvider(raw as AgentProviderName);
  return raw as AgentProviderName;
}
