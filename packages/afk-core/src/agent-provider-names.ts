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
