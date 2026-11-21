import type { AgentProviderName, AgentCapability, AgentCommand, AgentCommandOptions, AgentEvent } from './types.js';
import { ProcessAgentProvider } from './process-provider.js';

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming', 'usage', 'resume', 'interactive',
]);

interface CursorStreamEvent {
  type?: unknown;
  subtype?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  usage?: unknown;
  is_error?: unknown;
  result?: unknown;
  message?: unknown;
}

interface CursorUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
}

export class CursorProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'cursor';
  readonly capabilities = CAPABILITIES;
  protected readonly nativeSessions = true;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['cursor-agent'];
    const mode = options.executionMode ?? (options.interactive ? 'interactive' : 'batch');
    if (mode === 'batch') argv.push('--print', '--output-format', 'stream-json');
    const sessionId = this.resumeSessionId(options);
    if (sessionId) argv.push('--resume', sessionId);
    return { argv, cwd: options.worktreePath };
  }

  parseLine(line: string): AgentEvent[] {
    let parsed: CursorStreamEvent;
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [{ type: 'text', text: line }];
      parsed = value as CursorStreamEvent;
    } catch {
      return [{ type: 'text', text: line }];
    }
    const events: AgentEvent[] = [];
    if ((parsed.type === 'system' && parsed.subtype === 'init') || parsed.type === 'result') {
      if (typeof parsed.session_id === 'string') {
        events.push({ type: 'session', sessionId: parsed.session_id,
          ...(typeof parsed.cwd === 'string' ? { worktreePath: parsed.cwd } : {}) });
      }
    }
    if (parsed.type === 'result') {
      if (parsed.usage && typeof parsed.usage === 'object') {
        const usage = parsed.usage as CursorUsage;
        const fields = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;
        if (fields.some(field => usage[field] !== undefined)
          && fields.every(field => usage[field] === undefined || (typeof usage[field] === 'number' && Number.isFinite(usage[field]) && usage[field] >= 0))) {
          const inputTokens = Number(usage.inputTokens ?? 0) + Number(usage.cacheReadTokens ?? 0) + Number(usage.cacheWriteTokens ?? 0);
          const outputTokens = Number(usage.outputTokens ?? 0);
          events.push({ type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } });
        }
      }
      if (parsed.is_error === true || (parsed.subtype !== undefined && parsed.subtype !== 'success')) {
        events.push({ type: 'error', error: new Error(typeof parsed.result === 'string' ? parsed.result : 'Cursor agent failed') });
      } else if (typeof parsed.result === 'string') events.push({ type: 'result', result: parsed.result });
    } else if (parsed.type === 'assistant' && parsed.message && typeof parsed.message === 'object') {
      const message = parsed.message as { content?: unknown };
      if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block?.type === 'text' && typeof block.text === 'string') events.push({ type: 'text', text: block.text });
        }
      }
    }
    return events;
  }
}
