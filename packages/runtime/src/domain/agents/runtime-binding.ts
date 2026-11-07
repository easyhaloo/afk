/**
 * A provider and the runtime it runs with are one decision, not two.
 *
 * AFK resolves `agentProvider` once for the request, but a workflow step may
 * override it (`step.provider`). The runtime that step runs with was resolved
 * alongside the *request-level* provider, so a step that switched providers
 * silently kept the previous provider's runtime and lost every
 * provider-specific setting — for Codex that is `provider`, `profile` and
 * `transport`.
 *
 * The failure is silent by construction: the agent still starts, it just
 * starts against the wrong endpoint. Codex falls back to the host's default
 * provider instead of the one AFK was configured with, and the mismatch only
 * surfaces as a transport error from that other endpoint.
 *
 * This module makes the pairing explicit: whoever asks for a provider also
 * gets the runtime that belongs to it.
 */
import type { AgentProviderName, AgentRuntimeSelection } from './types.js';
import { DEFAULT_CODEX_CONFIG, resolveCodexRuntime, type CodexConfig } from './codex-runtime.js';

export interface RuntimeForProviderInput {
  /** The provider the step will actually run with. */
  provider: AgentProviderName;
  /** The runtime resolved for the request-level provider, if any. */
  runtime?: AgentRuntimeSelection;
  /** AFK's Codex configuration, used when a step runs Codex. */
  codex?: CodexConfig;
}

/**
 * Return the runtime that belongs to `provider`.
 *
 * Only Codex carries provider-specific settings today, so a non-Codex
 * provider resolves to no runtime at all — the same value AFK used before
 * provider-specific runtimes existed. A Codex runtime never runs a
 * non-Codex provider, and a non-Codex provider never inherits one.
 *
 * When the step's provider is Codex and the request-level runtime is not,
 * the Codex runtime is resolved from AFK's configuration so the step keeps
 * the provider, profile and transport the operator configured.
 */
export function resolveRuntimeForProvider(input: RuntimeForProviderInput): AgentRuntimeSelection | undefined {
  const { provider, runtime } = input;
  if (provider !== 'codex') return undefined;
  if (runtime?.kind === 'codex') return runtime;
  const configured = input.codex ?? {
    ...DEFAULT_CODEX_CONFIG,
    appServer: { ...DEFAULT_CODEX_CONFIG.appServer },
  };
  return resolveCodexRuntime({ cli: {}, config: configured });
}
