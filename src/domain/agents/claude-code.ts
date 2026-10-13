/**
 * Claude Code agent provider.
 *
 * Implements AgentProvider for the Claude Code CLI.
 * Session management uses the Claude Code session directory;
 * command is built for execution inside a Sandbox.
 */

import type {
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
} from './types.js';
import { ProcessAgentProvider } from './process-provider.js';

/** Claude Code capabilities */
const CAPABILITIES: ReadonlySet<AgentCapability> = new Set([
  'streaming',
  'structured-output',
  'usage',
  'resume',
  'interactive',
]);

/**
 * Normalise Claude Code's usage block to `TokenUsage`.
 *
 * `input_tokens` EXCLUDES cache creation/read — on a real run it was 5252
 * against 20569 cache-creation tokens, so reading it alone would under-report
 * by ~80%. `output_tokens_details.thinking_tokens` is a breakdown OF
 * `output_tokens`, never additional to it.
 */
interface ClaudeUsageBlock {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
}

function toTokenUsage(usage: ClaudeUsageBlock): TokenUsage {
  const num = (key: keyof ClaudeUsageBlock): number => (typeof usage[key] === 'number' ? usage[key]! : 0);
  const inputTokens = num('input_tokens') + num('cache_creation_input_tokens') + num('cache_read_input_tokens');
  const outputTokens = num('output_tokens');
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}

export class ClaudeCodeProvider extends ProcessAgentProvider {
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
    // Claude Code emits one JSON event per stdout line when structured output
    // is enabled. The terminal `result` event carries the finished aggregate,
    // so reading it is reading the final state — no separate flush wait.
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'usage' && parsed.usage) {
        return [{ type: 'usage', usage: toTokenUsage(parsed.usage) }];
      }
      if (parsed.type === 'result') {
        const events: AgentEvent[] = [];
        if (parsed.usage) events.push({ type: 'usage', usage: toTokenUsage(parsed.usage) });
        if (typeof parsed.session_id === 'string' && parsed.session_id.length > 0) {
          events.push({ type: 'session', sessionId: parsed.session_id });
        }
        const resultEvent: AgentEvent = { type: 'result', result: parsed.result };
        if (parsed.is_error === true) {
          events.push(
            { type: 'error', error: new Error(String(parsed.result ?? 'agent returned an error')) },
            resultEvent,
          );
          return events;
        }
        events.push(resultEvent);
        return events;
      }
    } catch {
      // Not JSON — treat as text output
    }
    return [{ type: 'text', text: line }];
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
