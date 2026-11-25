/**
 * OpenCode agent provider (sst/opencode).
 *
 * Flag surface verified against the installed binary (opencode 1.18.31):
 *
 * Interactive — `opencode` (default TUI command):
 *   --model <provider/model>   select provider+model
 *   --auto                     auto-approve permissions not explicitly denied
 *   --prompt <text>            sets the editor input and auto-submits it once
 *                              the TUI is ready (home route, new session)
 *
 * Batch — `opencode run`:
 *   --format json              NDJSON events on stdout (step_start / text /
 *                              step_finish with part.tokens)
 *   --model <provider/model>   select provider+model
 *   [message..]                message to send; when stdin is piped, stdin is
 *                              prepended, so the goal is written to stdin
 *
 * The adapter captures a batch session ID but does not implement resume.
 *
 * Model selection is runtime configuration, never product source: resolve
 * `AFK_OPENCODE_MODEL` (format `provider/model`) when set and omit --model
 * otherwise so opencode uses its own configured default.
 *
 * Reference: https://opencode.ai/docs/cli
 */

import type {
  AgentProviderName,
  AgentCapability,
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  TokenUsage,
} from './types.js';
import { ProcessAgentProvider } from './process-provider.js';

const CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  'streaming',
  'usage',
  'interactive',
] as const);

export const OPENCODE_MODEL_ENV = 'AFK_OPENCODE_MODEL';

export function resolveOpenCodeModel(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[OPENCODE_MODEL_ENV]?.trim();
  return value ? value : undefined;
}

export class OpenCodeProvider extends ProcessAgentProvider {
  readonly name: AgentProviderName = 'opencode';
  readonly capabilities: ReadonlySet<AgentCapability> = CAPABILITIES;
  protected readonly nativeSessions = 'batch' as const;

  override async restoreSession(): Promise<void> {
    throw new Error('OpenCode native resume is not supported');
  }

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const model = resolveOpenCodeModel();
    if (options.executionMode === 'batch') {
      const argv = ['opencode', 'run', '--format', 'json'];
      if (model) argv.push('--model', model);
      if (options.skillTask && options.skillTask.workspace === options.worktreePath) {
        return { argv: [...argv, '--standalone'], cwd: options.worktreePath, env: { AFK_SKILL_TASK_CONTEXT: JSON.stringify(options.skillTask) } };
      }
      return { argv, cwd: options.worktreePath };
    }

    const argv = ['opencode', '--auto'];
    if (model) argv.push('--model', model);
    if (options.goal) argv.push('--prompt', options.goal.trim().replace(/^\/goal\s*/i, ''));
    return { argv, cwd: options.worktreePath };
  }

  protected override createParser(): (line: string) => AgentEvent[] {
    let step: { session: string; message: string; text: string; usedTool: boolean } | undefined;
    let inputTokens = 0;
    let outputTokens = 0;
    let stopped = false;
    return line => {
      let event;
      try { event = JSON.parse(line); } catch { return [{ type: 'text', text: line }]; }
      const part = event?.part;
      if (event?.type === 'error') {
        step = undefined;
        return [{ type: 'error', error: new Error('OpenCode reported a session error') }];
      }
      if (!part || typeof event.sessionID !== 'string' || part.sessionID !== event.sessionID || typeof part.messageID !== 'string') return [];
      if (event.type === 'step_start' && part.type === 'step-start') {
        if (stopped) return [{ type: 'error', error: new Error('OpenCode started another step after stop') }];
        step = { session: event.sessionID, message: part.messageID, text: '', usedTool: false };
        return [{ type: 'session', sessionId: event.sessionID }];
      }
      if (!step || step.session !== part.sessionID || step.message !== part.messageID) return [];
      if (event.type === 'tool_use' && part.type === 'tool') step.usedTool = true;
      if (event.type === 'text' && part.type === 'text' && typeof part.text === 'string') {
        step.text += part.text;
        return [{ type: 'text', text: part.text }];
      }
      if (event.type !== 'step_finish' || part.type !== 'step-finish') return [];
      const events: AgentEvent[] = [];
      const usage = openCodeUsage(part.tokens);
      if (usage) {
        inputTokens += usage.inputTokens;
        outputTokens += usage.outputTokens;
        events.push({ type: 'usage', usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }, contextTokens: usage.totalTokens });
      }
      stopped = part.reason === 'stop';
      if (stopped && !step.usedTool && step.text) events.push({ type: 'result', result: step.text });
      step = undefined;
      return events;
    };
  }
}

function openCodeUsage(tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }): TokenUsage | undefined {
  if (!tokens || tokens.input === undefined || tokens.output === undefined) return undefined;
  const { input, output, reasoning = 0, cache } = tokens;
  const { read = 0, write = 0 } = cache ?? {};
  if (![input, output, reasoning, read, write].every(count => Number.isSafeInteger(count) && count >= 0)) return undefined;
  const inputTokens = input + read + write;
  const outputTokens = output + reasoning;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
}
