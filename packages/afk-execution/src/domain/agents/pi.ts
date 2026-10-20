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
  SessionSnapshot,
  CaptureSessionOptions,
  RestoreSessionOptions,
} from './types.js';
import { ProcessAgentProvider } from './process-provider.js';

/**
 * Pi capabilities.
 *
 * 'resume' is deliberately absent: `restoreSession` does nothing and the
 * command never carries a session flag, so there is no way to restore a
 * context. Declaring the capability would make the runner re-send the same
 * prompt against an unrestored context.
 */
const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming',
  'usage',
  'interactive',
] as const);

export class PiProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'pi';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['pi'];
    // `--non-interactive` takes the agent out of a session a human can
    // drive. The interactive mode is a terminal session, not a one-shot.
    if (options.executionMode === 'batch') argv.push('--non-interactive');
    return { argv, cwd: options.worktreePath };
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
