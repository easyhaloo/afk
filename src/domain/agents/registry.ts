/**
 * Agent provider registry — central lookup for AgentProvider instances.
 *
 * Providers register themselves by name; the runner resolves a provider by
 * AgentProviderName. The registry also enforces capability gating:
 * `restoreSession` throws if the provider does not declare the 'resume'
 * capability, so a non-resume provider can never silently enter the resume
 * flow (a design-doc hard requirement).
 *
 * Providers are registered once at module load and treated as immutable
 * singletons thereafter. Tests can register throwaway providers.
 */

import type { AgentProvider, AgentProviderName, RestoreSessionOptions } from './types';

const providers = new Map<AgentProviderName, AgentProvider>();

/**
 * Register an AgentProvider. Overwrites any existing provider with the same
 * name. Intended for module-load registration; tests use it to inject fakes.
 */
export function registerAgentProvider(provider: AgentProvider): void {
  providers.set(provider.name, provider);
}

/**
 * Look up a registered provider by name. Returns undefined if not registered;
 * callers should `requireAgentProvider` when they need a guaranteed instance.
 */
export function getAgentProvider(name: AgentProviderName): AgentProvider | undefined {
  return providers.get(name);
}

/**
 * Same as getAgentProvider but throws if missing — used by the runner.
 */
export function requireAgentProvider(name: AgentProviderName): AgentProvider {
  const p = providers.get(name);
  if (!p) {
    throw new Error(`agent provider not registered: ${name}`);
  }
  return p;
}

/**
 * List all registered provider names. Stable order = registration order.
 */
export function listAgentProviders(): AgentProviderName[] {
  return [...providers.keys()];
}

/** Clear the registry — used by tests to isolate state. */
export function _resetAgentRegistry(): void {
  providers.clear();
}

/**
 * Capability-gating restoreSession wrapper. Throws if the provider does not
 * declare 'resume' — the design doc requires that non-resume providers must
 * NOT enter the resume flow. Without this gate a missing capability could
 * silently fall through to a no-op implementation.
 */
export async function guardedRestoreSession(
  provider: AgentProvider,
  options: RestoreSessionOptions,
): Promise<void> {
  if (!provider.capabilities.has('resume')) {
    throw new Error(
      `agent provider '${provider.name}' does not support resume; ` +
        `use handoff Markdown fallback instead`,
    );
  }
  if (!provider.restoreSession) {
    throw new Error(
      `agent provider '${provider.name}' declares 'resume' capability but ` +
        `restoreSession() is not implemented`,
    );
  }
  await provider.restoreSession(options);
}

/**
 * Capability-gating captureSession wrapper. Same rule as guardedRestoreSession.
 */
export async function guardedCaptureSession(
  provider: AgentProvider,
  options: import('./types').CaptureSessionOptions,
): Promise<import('./types').SessionSnapshot> {
  if (!provider.capabilities.has('resume')) {
    throw new Error(
      `agent provider '${provider.name}' does not support resume; ` +
        `cannot capture session for restore`,
    );
  }
  if (!provider.captureSession) {
    throw new Error(
      `agent provider '${provider.name}' declares 'resume' capability but ` +
        `captureSession() is not implemented`,
    );
  }
  return provider.captureSession(options);
}