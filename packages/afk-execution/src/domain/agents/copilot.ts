/**
 * GitHub Copilot CLI agent provider.
 *
 * Copilot CLI flag surface (verified partial via WebSearch 2026-08):
 *   --prompt <text>            one-shot prompt (non-interactive)
 *   --allow-all                allow all tool permissions
 *   --model <name>             select model
 *
 * Resume: GitHub Copilot CLI does NOT expose a documented --resume flag.
 * Capability: NO 'resume'.
 *
 * Reference: GitHub Copilot CLI documentation (npm: @github/copilot).
 */

import type {
  AgentProviderName,
  AgentCapability,
  AgentCommand,
  AgentCommandOptions,
} from './types.js';
import { ProcessAgentProvider } from './process-provider.js';

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming',
  'usage',
  'interactive',
] as const);

export class CopilotProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'copilot';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    // `--allow-all` is not a mode: a permission prompt has nobody to answer
    // it. The interactive mode is a terminal session a human may attach to,
    // not a step gate, so the agent runs with its permissions allowed in
    // either mode — the same choice claude-code and codex make.
    const argv = ['copilot', '--allow-all'];
    return { argv, cwd: options.worktreePath };
  }
}
