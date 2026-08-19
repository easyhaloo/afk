/**
 * Codex agent provider (OpenAI Codex CLI).
 *
 * Batch execution uses `codex exec --json` and translates Codex JSONL into
 * provider-neutral events. Interactive execution remains tmux-driven.
 *
 * Reference: https://developers.openai.com/codex/cli/reference
 */

import type {
  AgentExecutionMetadata,
  AgentExecutionOptions,
  AgentProviderName,
  AgentCapability,
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  AgentExecution,
} from './types';
import { ProcessAgentProvider } from './process-provider';
import { CodexAppServerExecution } from './codex-app-server/execution';

type CodexJsonEvent = { [key: string]: unknown };

/** Codex capabilities — resume deliberately excluded. */
const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming',
  'structured-output',
  'usage',
  'interactive',
] as const);

export class CodexProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'codex';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;

  override async createExecution(options: AgentExecutionOptions): Promise<AgentExecution> {
    if (options.runtime?.kind === 'codex' && options.runtime.transport === 'app-server') {
      return CodexAppServerExecution.start(options, options.runtime);
    }
    return super.createExecution(options);
  }

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const argv = ['codex'];
    if (options.executionMode === 'batch') {
      argv.push('exec', '--json');
    }
    const runtime = options.runtime?.kind === 'codex' ? options.runtime : undefined;
    if (runtime?.profile) argv.push('--profile', runtime.profile);
    if (runtime?.provider && runtime.provider !== 'auto') {
      argv.push('--config', `model_provider=${JSON.stringify(runtime.provider)}`);
    }
    argv.push('--dangerously-bypass-approvals-and-sandbox');
    if (options.executionMode !== 'batch') argv.push('--no-alt-screen');
    argv.push('-C', options.worktreePath);
    return { argv, cwd: options.worktreePath };
  }

  parseLine(line: string): AgentEvent[] {
    let event: CodexJsonEvent;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object') return [{ type: 'text', text: line }];
      event = parsed as CodexJsonEvent;
    } catch {
      return [{ type: 'text', text: line }];
    }

    if (event.type === 'item.completed' && isRecord(event.item)) {
      const item = event.item;
      if (item.type === 'agent_message' && typeof item.text === 'string') {
        return [{ type: 'result', result: item.text }];
      }
    }

    if (event.type === 'turn.completed' && isRecord(event.usage)) {
      const inputTokens = numberValue(event.usage.input_tokens);
      const outputTokens = numberValue(event.usage.output_tokens);
      return [{
        type: 'usage',
        usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
      }];
    }

    if (event.type === 'error' || event.type === 'turn.failed') {
      return [{ type: 'error', error: new Error(errorMessage(event)) }];
    }

    return [{ type: 'text', text: line }];
  }

  protected override executionMetadata(options: AgentExecutionOptions): AgentExecutionMetadata {
    const runtime = options.runtime?.kind === 'codex' ? options.runtime : undefined;
    return {
      provider: this.name,
      transport: 'exec',
      ...(runtime ? { auth: runtime.auth, modelProvider: runtime.provider } : {}),
    };
  }
}

function isRecord(value: unknown): value is CodexJsonEvent {
  return value !== null && typeof value === 'object';
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function errorMessage(event: CodexJsonEvent): string {
  if (typeof event.message === 'string' && event.message.trim()) return event.message;
  if (typeof event.error === 'string' && event.error.trim()) return event.error;
  if (isRecord(event.error) && typeof event.error.message === 'string' && event.error.message.trim()) {
    return event.error.message;
  }
  return 'Codex execution failed';
}
