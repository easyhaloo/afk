/**
 * Codex agent provider (OpenAI Codex CLI).
 *
 * Codex CLI flag surface (verified partial via WebSearch 2026-08):
 *   --model <name>            select model
 *   --approval-mode <mode>    suggest | auto-edit | full-auto
 *   --quiet, -q               suppress non-essential output
 *   --profile <name>          named config profile from config.toml
 *   --sandbox <mode>          sandbox mode
 *
 * Resume: Codex CLI does NOT expose a documented resume flag — sessions
 * are stateless from CLI perspective. Capability: NO 'resume'.
 *
 * Streaming: Codex emits JSON lines when --json is passed (TODO: verify).
 * Capability: 'streaming' is conditional; declare only what is verified.
 *
 * Reference: https://developers.openai.com/codex/cli/reference
 */

import type {
  AgentProvider,
  AgentProviderName,
  AgentCapability,
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
} from './types';

/** Codex capabilities — resume deliberately excluded. */
const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'usage',
  'interactive',
] as const);

export class CodexProvider implements AgentProvider {
  readonly name: AgentProviderName = 'codex';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['codex'];
    if (options.interactive) argv.push('--full-auto');
    return { argv, cwd: options.worktreePath };
  }

  parseLine(line: string): AgentEvent[] {
    // Codex JSON-line shape TBD — return text until verified.
    return [{ type: 'text', text: line }];
  }
}