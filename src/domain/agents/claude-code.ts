/**
 * Claude Code agent provider.
 *
 * Implements AgentProvider for the Claude Code CLI.
 * Session management uses the Claude Code session directory;
 * command is built for execution inside a Sandbox.
 */

import type {
  AgentProvider,
  AgentProviderName,
  AgentCapability,
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  AgentSession,
  TokenUsage,
  SessionSnapshot,
  CaptureSessionOptions,
  RestoreSessionOptions,
} from './types';

/** Claude Code capabilities */
const CAPABILITIES: ReadonlySet<AgentCapability> = new Set([
  'streaming',
  'structured-output',
  'usage',
  'resume',
  'interactive',
]);

export class ClaudeCodeProvider implements AgentProvider {
  readonly name: AgentProviderName = 'claude-code';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['claude', '--dangerously-skip-permissions'];
    if (options.executionMode === 'batch') {
      argv.push('--print', '--output-format', 'stream-json', '--verbose');
    } else if (options.interactive) {
      argv.push('--no-input');
    }
    return {
      argv,
      cwd: options.worktreePath,
    };
  }

  parseLine(line: string): AgentEvent[] {
    // Claude Code emits structured JSON events on stdout when structured
    // output is enabled. This is a placeholder — full JSON stream parsing
    // is Phase 3 (streaming).
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'usage' && parsed.usage) {
        return [{ type: 'usage', usage: parsed.usage as TokenUsage }];
      }
      if (parsed.type === 'result') {
        const resultEvent: AgentEvent = { type: 'result', result: parsed.result };
        if (parsed.is_error === true) {
          return [
            { type: 'error', error: new Error(String(parsed.result ?? 'agent returned an error')) },
            resultEvent,
          ];
        }
        return [resultEvent];
      }
    } catch {
      // Not JSON — treat as text output
    }
    return [{ type: 'text', text: line }];
  }

  async getSessionUsage(session: AgentSession): Promise<TokenUsage | undefined> {
    // Usage is obtained from the statusline tee in the worktree.
    // This method exists for providers that expose a native usage API.
    return undefined;
  }

  async captureSession(_options: CaptureSessionOptions): Promise<SessionSnapshot> {
    // Claude Code sessions are managed by the Claude Code CLI.
    // Placeholder for Phase 3/4 session capture.
    return {
      sessionId: _options.sessionId,
      generation: 1,
      checkpoint: null,
      summary: '',
      capturedAt: new Date().toISOString(),
    };
  }

  async restoreSession(_options: RestoreSessionOptions): Promise<void> {
    // Claude Code session restore is Phase 3/4.
  }
}
