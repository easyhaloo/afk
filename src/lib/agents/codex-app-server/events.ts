import type { TokenUsage } from '../types';
import type { JsonRpcMessage } from './transport';

export type AppServerEvent =
  | { type: 'result'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'completed'; status: string }
  | { type: 'error'; error: Error };

export function normalizeAppServerNotification(message: JsonRpcMessage): AppServerEvent[] {
  const params = record(message.params);
  switch (message.method) {
    case 'item/completed': {
      const item = record(params.item);
      return item.type === 'agentMessage' && typeof item.text === 'string'
        ? [{ type: 'result', text: item.text }]
        : [];
    }
    case 'thread/tokenUsage/updated': {
      const tokenUsage = record(params.tokenUsage ?? params.usage);
      const raw = record(tokenUsage.total ?? tokenUsage);
      const inputTokens = number(raw.inputTokens ?? raw.input_tokens);
      const outputTokens = number(raw.outputTokens ?? raw.output_tokens);
      const totalTokens = number(raw.totalTokens ?? raw.total_tokens) || inputTokens + outputTokens;
      return [{ type: 'usage', usage: { inputTokens, outputTokens, totalTokens } }];
    }
    case 'turn/completed': {
      const turn = record(params.turn);
      const status = typeof turn.status === 'string' ? turn.status : 'completed';
      return status === 'failed'
        ? [{ type: 'error', error: new Error(errorMessage(turn)) }]
        : [{ type: 'completed', status }];
    }
    case 'error':
      return params.willRetry === true
        ? []
        : [{ type: 'error', error: new Error(errorMessage(params)) }];
    default:
      return [];
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function errorMessage(value: Record<string, unknown>): string {
  const error = record(value.error);
  if (typeof value.message === 'string' && value.message.trim()) return value.message;
  if (typeof error.message === 'string' && error.message.trim()) return error.message;
  return 'Codex app-server turn failed';
}
