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
 * Resume: opencode does not expose a documented --resume flag — sessions
 * are managed via its TUI. Capability: NO 'resume'.
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

  buildCommand(options: AgentCommandOptions): AgentCommand {
    const model = resolveOpenCodeModel();
    if (options.executionMode === 'batch') {
      const argv = ['opencode', 'run', '--format', 'json'];
      if (model) argv.push('--model', model);
      return { argv, cwd: options.worktreePath };
    }

    const argv = ['opencode', '--auto'];
    if (model) argv.push('--model', model);
    if (options.goal) argv.push('--prompt', options.goal.trim().replace(/^\/goal\s*/i, ''));
    return { argv, cwd: options.worktreePath };
  }

  parseLine(line: string): AgentEvent[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [{ type: 'text', text: line }];
    }
    if (!parsed || typeof parsed !== 'object') return [{ type: 'text', text: line }];
    const event = parsed as { type?: unknown; part?: unknown; [key: string]: unknown };

    if (event.type === 'text' && event.part && typeof event.part === 'object') {
      const text = (event.part as { text?: unknown }).text;
      if (typeof text === 'string') return [{ type: 'text', text }, { type: 'result', result: text }];
    }

    if (event.type === 'step_finish' && event.part && typeof event.part === 'object') {
      const tokens = (event.part as { tokens?: { input?: unknown; output?: unknown } }).tokens;
      if (tokens && typeof tokens === 'object') {
        const input = typeof tokens.input === 'number' && Number.isFinite(tokens.input) ? tokens.input : 0;
        const output = typeof tokens.output === 'number' && Number.isFinite(tokens.output) ? tokens.output : 0;
        const usage: TokenUsage = { inputTokens: input, outputTokens: output, totalTokens: input + output };
        return [{ type: 'usage', usage }, { type: 'result', result: event }];
      }
      return [{ type: 'result', result: event }];
    }

    if (event.type === 'step_start' && typeof event.sessionID === 'string') {
      return [{ type: 'session', sessionId: event.sessionID }];
    }

    return [{ type: 'text', text: line }];
  }
}
