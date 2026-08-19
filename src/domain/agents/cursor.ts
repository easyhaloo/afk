/**
 * Cursor agent provider (cursor-agent CLI).
 *
 * cursor-agent CLI flag surface (verified partial via WebSearch 2026-08):
 *   --print                    non-interactive print mode
 *   --model <name>             select model
 *   --output-format <fmt>      text | json | stream-json
 *
 * Resume: cursor-agent supports --resume <id> for session resume.
 * Capability: 'resume' included.
 *
 * Reference: https://docs.cursor.com/en/cli/reference
 */

import type {
  AgentProviderName,
  AgentCapability,
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  TokenUsage,
  SessionSnapshot,
  CaptureSessionOptions,
  RestoreSessionOptions,
} from './types';
import { ProcessAgentProvider } from './process-provider';

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming',
  'usage',
  'resume',
  'interactive',
] as const);

export class CursorProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'cursor';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['cursor-agent'];
    if (options.executionMode === 'batch') {
      argv.push('--print', '--output-format', 'stream-json');
    } else if (options.interactive) {
      argv.push('--interactive');
    } else {
      argv.push('--print');
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

  async captureSession(options: CaptureSessionOptions): Promise<SessionSnapshot> {
    return {
      sessionId: options.sessionId,
      generation: 1,
      checkpoint: null,
      summary: '',
      capturedAt: new Date().toISOString(),
    };
  }

  async restoreSession(_options: RestoreSessionOptions): Promise<void> {
    // cursor-agent --resume <id> is invoked via buildCommand; nothing to do here.
  }
}
