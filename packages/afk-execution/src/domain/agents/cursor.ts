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
  SessionSnapshot,
  CaptureSessionOptions,
  RestoreSessionOptions,
} from './types.js';
import { ProcessAgentProvider } from './process-provider.js';

/**
 * Cursor capabilities.
 *
 * 'resume' is deliberately absent: `restoreSession` does nothing and the
 * command never carries a resume flag, so there is no way to restore a
 * context. Declaring the capability would make the runner re-send the same
 * prompt against an unrestored context.
 */
const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming',
  'usage',
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
