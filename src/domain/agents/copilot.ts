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
  AgentProvider,
  AgentProviderName,
  AgentCapability,
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  TokenUsage,
} from './types';

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming',
  'usage',
  'interactive',
] as const);

export class CopilotProvider implements AgentProvider {
  readonly name: AgentProviderName = 'copilot';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['copilot'];
    if (!options.interactive) {
      argv.push('--allow-all');
    }
    return { argv, cwd: options.worktreePath };
  }

  parseLine(line: string): AgentEvent[] {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'usage' && parsed.usage) {
        return [{ type: 'usage', usage: parsed.usage as TokenUsage }];
      }
      if (parsed.type === 'result') {
        return [{ type: 'result', result: parsed.result }];
      }
    } catch {
      // Not JSON — text
    }
    return [{ type: 'text', text: line }];
  }
}