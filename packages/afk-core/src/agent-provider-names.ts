/**
 * The agent providers AFK can drive.
 *
 * The list is the vocabulary. The execution runtime registers a provider
 * under one of these names, the template schema validates a step's
 * provider against them, and the desktop client offers the same set.
 * Writing the names down in each of those places let a template name a
 * provider the runtime had never heard of, and let the desktop offer a
 * provider the runtime could not run.
 *
 * The list lives in the core package because the desktop client reads it
 * from a renderer that cannot load the execution runtime, and the core
 * package is the one layer every one of them can reach.
 */
export const AGENT_PROVIDER_NAMES = [
  'claude-code',
  'codex',
  'cursor',
  'pi',
  'opencode',
  'copilot',
] as const;

export type AgentProviderName = (typeof AGENT_PROVIDER_NAMES)[number];

/** Whether a value names an agent provider AFK can drive. */
export function isAgentProviderName(value: unknown): value is AgentProviderName {
  return typeof value === 'string' && (AGENT_PROVIDER_NAMES as readonly string[]).includes(value);
}

/**
 * The harnesses whose transcripts AFK can read.
 *
 * Not every provider AFK can drive has a transcript reader: a provider
 * with no reader here is a provider a retro cannot gather evidence from.
 * The list is named so a caller can refuse a provider it cannot read
 * rather than treat it as one it can.
 *
 * It is a subset of the providers AFK can drive, and it is read from that
 * list rather than written out again: a provider added to the list of
 * drivable providers is not thereby one whose transcript can be read.
 */
export const AGENT_TELEMETRY_PROVIDERS = ['claude-code', 'codex', 'opencode'] as const;

export type AgentTelemetryProvider = (typeof AGENT_TELEMETRY_PROVIDERS)[number];

/** Whether a value names a harness whose transcripts AFK can read. */
export function isAgentTelemetryProvider(value: unknown): value is AgentTelemetryProvider {
  return typeof value === 'string' && (AGENT_TELEMETRY_PROVIDERS as readonly string[]).includes(value);
}
