/**
 * OpenCode agent provider (sst/opencode).
 *
 * OpenCode is a Go-based CLI from SST. Flag surface (verified partial via
 * WebSearch 2026-08):
 *   --print-logs               emit logs to stdout
 *   --log-level <level>        DEBUG | INFO | WARN | ERROR
 *   --model <provider/model>    select provider+model
 *   --format <fmt>             text | json
 *
 * Resume: opencode does NOT expose a documented --resume flag — sessions
 * are managed via its TUI. Capability: NO 'resume'.
 *
 * Reference: https://opencode.ai/docs/cli
 */

import type {
  AgentProviderName,
  AgentCapability,
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
} from './types';
import { ProcessAgentProvider } from './process-provider';

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming',
  'usage',
  'interactive',
] as const);

export class OpenCodeProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'opencode';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['opencode', '--format', 'json'];
    if (!options.interactive) argv.push('--non-interactive');
    return { argv, cwd: options.worktreePath };
  }

  parseLine(line: string): AgentEvent[] {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'usage' && parsed.usage) {
        return [{ type: 'usage', usage: parsed.usage as import('./types').TokenUsage }];
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
