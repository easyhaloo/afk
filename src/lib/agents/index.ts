/**
 * Agent providers — registry and factory.
 */
import { requireAgentProvider, getAgentProvider, registerAgentProvider } from './registry';
import type { AgentProvider, AgentProviderName } from './types';
import { ClaudeCodeProvider } from './claude-code';
import { CodexProvider } from './codex';
import { CursorProvider } from './cursor';
import { PiProvider } from './pi';
import { OpenCodeProvider } from './opencode';
import { CopilotProvider } from './copilot';
export { registerAgentProvider, getAgentProvider, requireAgentProvider } from './registry';
export type { AgentProvider, AgentProviderName, AgentCapability, AgentCommand, AgentEvent, AgentSession, TokenUsage, SessionSnapshot, AgentCommandOptions, CaptureSessionOptions, RestoreSessionOptions } from './types';

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
