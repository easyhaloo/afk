/**
 * Agent providers — registry and factory.
 */
import { requireAgentProvider } from './registry';
import type { AgentProvider, AgentProviderName } from './types';
export { registerAgentProvider, getAgentProvider, requireAgentProvider } from './registry';
export type { AgentProvider, AgentProviderName, AgentCapability, AgentCommand, AgentEvent, AgentSession, TokenUsage, SessionSnapshot, AgentCommandOptions, CaptureSessionOptions, RestoreSessionOptions } from './types';

/**
 * Factory: resolve an AgentProviderName to a registered AgentProvider instance.
 * All provider-internal assembly is encapsulated here — callers only get
 * the ready-to-use provider. The default is 'claude-code'.
 */
export function createAgentProvider(name: AgentProviderName = 'claude-code'): AgentProvider {
  return requireAgentProvider(name);
}
