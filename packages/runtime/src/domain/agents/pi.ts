import type { AgentProviderName, AgentCapability, AgentCommand, AgentCommandOptions, AgentEvent } from './types.js';
import { ProcessAgentProvider } from './process-provider.js';

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming', 'usage', 'resume', 'interactive',
]);

interface PiStreamEvent {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
  assistantMessageEvent?: unknown;
  message?: unknown;
  aborted?: unknown;
}

interface PiAssistantMessage {
  role?: unknown;
  content?: unknown;
  usage?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

interface PiUsage {
  input?: unknown;
  output?: unknown;
  cacheRead?: unknown;
  cacheWrite?: unknown;
}

function record(line: string): PiStreamEvent | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as PiStreamEvent : undefined;
  } catch {
    return undefined;
  }
}

export class PiProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'pi';
  readonly capabilities = CAPABILITIES;
  protected readonly nativeSessions = true;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['pi'];
    const mode = options.executionMode ?? (options.interactive ? 'interactive' : 'batch');
    if (mode === 'batch') argv.push('--print', '--mode', 'json');
    const sessionId = this.resumeSessionId(options);
    if (sessionId) argv.push('--session', sessionId);
    return { argv, cwd: options.worktreePath };
  }

  parseLine(line: string): AgentEvent[] {
    const parsed = record(line);
    if (!parsed) return [{ type: 'text', text: line }];
    if (parsed.type === 'session' && typeof parsed.id === 'string') {
      return [{ type: 'session', sessionId: parsed.id,
        ...(typeof parsed.cwd === 'string' ? { worktreePath: parsed.cwd } : {}) }];
    }
    if (parsed.type === 'message_update' && parsed.assistantMessageEvent && typeof parsed.assistantMessageEvent === 'object') {
      const update = parsed.assistantMessageEvent as { type?: unknown; delta?: unknown };
      return update.type === 'text_delta' && typeof update.delta === 'string' ? [{ type: 'text', text: update.delta }] : [];
    }
    if (parsed.type !== 'message_end' || !parsed.message || typeof parsed.message !== 'object') return [];
    const message = parsed.message as PiAssistantMessage;
    if (message.role !== 'assistant') return [];
    const events: AgentEvent[] = [];
    if (Array.isArray(message.content)) {
      const text = message.content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('');
      events.push({ type: 'text', text });
    }
    if (message.usage && typeof message.usage === 'object') {
      const usage = message.usage as PiUsage;
      const fields = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;
      if (fields.some(field => usage[field] !== undefined)
        && fields.every(field => usage[field] === undefined || (typeof usage[field] === 'number' && Number.isFinite(usage[field]) && usage[field] >= 0))) {
        const inputTokens = Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0);
        const outputTokens = Number(usage.output ?? 0);
        events.push({ type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } });
      }
    }
    return events;
  }

  protected override createParser(): (line: string) => AgentEvent[] {
    let finalText: string | undefined;
    let stopReason: unknown;
    let errorMessage: unknown;
    let inputTokens = 0;
    let outputTokens = 0;
    return line => {
      const parsed = record(line);
      if (parsed?.type === 'agent_start') {
        finalText = undefined;
        stopReason = undefined;
        errorMessage = undefined;
      }
      if (parsed?.type === 'agent_settled') {
        if (parsed.aborted === true || stopReason !== 'stop' || finalText === undefined) {
          return [{ type: 'error', error: new Error(typeof errorMessage === 'string' ? errorMessage : `Pi run did not complete (${String(stopReason ?? 'missing message')})`) }];
        }
        return [{ type: 'result', result: finalText }];
      }
      const events = this.parseLine(line);
      if (parsed?.type === 'message_end' && parsed.message && typeof parsed.message === 'object') {
        const message = parsed.message as PiAssistantMessage;
        if (message.role === 'assistant') {
          finalText = events.filter(event => event.type === 'text').map(event => event.text).join('');
          stopReason = message.stopReason;
          errorMessage = message.errorMessage;
        }
      }
      return events.map(event => {
        if (event.type !== 'usage') return event;
        inputTokens += event.usage.inputTokens;
        outputTokens += event.usage.outputTokens;
        return { type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens } };
      });
    };
  }
}
