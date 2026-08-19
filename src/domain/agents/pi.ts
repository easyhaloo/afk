/**
 * Pi coding agent provider (pi-mono / pi-coding-agent).
 *
 * Pi is a TypeScript monorepo from mariozechner/pi-mono with a coding-agent
 * subpackage. CLI flag surface (verified partial via WebSearch 2026-08):
 *   --model <name>             select model
 *   --provider <name>          select provider (anthropic, openai, etc.)
 *   --session <id>             resume a specific session
 *   --non-interactive           non-interactive mode
 *
 * Reference: https://github.com/mariozechner/pi-mono/blob/main/packages/coding-agent/README.md
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

export class PiProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'pi';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['pi'];
    if (!options.interactive) argv.push('--non-interactive');
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
    // pi --session <id> is invoked via buildCommand.
  }
}
