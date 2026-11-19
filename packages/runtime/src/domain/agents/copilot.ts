import type { AgentCapability, AgentCommand, AgentCommandOptions, AgentEvent } from './types.js';
import { ProcessAgentProvider } from './process-provider.js';

export class CopilotProvider extends ProcessAgentProvider {
  readonly name = 'copilot';
  readonly capabilities: ReadonlySet<AgentCapability> = new Set(['streaming', 'usage', 'interactive']);
  protected readonly nativeSessions = true;

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const batch = (options.executionMode ?? (options.interactive ? 'interactive' : 'batch')) === 'batch';
    return { argv: batch ? ['copilot', '--output-format', 'json', '--stream', 'on'] : ['copilot'], cwd: options.worktreePath };
  }

  override async restoreSession(): Promise<void> {
    throw new Error('Copilot native resume is not supported');
  }

  protected override createParser(): (line: string) => AgentEvent[] {
    let sessionId: string | undefined;
    let answer: string | undefined;
    return line => {
      let row;
      try { row = JSON.parse(line); } catch { return []; }
      const data = row?.data;
      switch (row?.type) {
        case 'session.start':
          if (typeof data?.sessionId !== 'string' || typeof data.context?.cwd !== 'string') return [];
          sessionId = data.sessionId;
          return [{ type: 'session', sessionId: data.sessionId, worktreePath: data.context.cwd }];
        case 'assistant.turn_start':
          answer = undefined;
          return [];
        case 'assistant.message_delta':
          return typeof data?.deltaContent === 'string' ? [{ type: 'text', text: data.deltaContent }] : [];
        case 'assistant.message':
          answer = typeof data?.content === 'string' && Array.isArray(data.toolRequests) && !data.toolRequests.length ? data.content : undefined;
          return [];
        case 'session.error':
          return [{ type: 'error', error: new Error(typeof data?.message === 'string' ? data.message : 'Copilot session failed') }];
        case 'result':
          if (!sessionId || row.sessionId !== sessionId || row.exitCode !== 0 || answer === undefined) {
            return [{ type: 'error', error: new Error('Copilot did not confirm a completed assistant response') }];
          }
          return [{ type: 'result', result: answer }];
        default:
          return [];
      }
    };
  }
}
