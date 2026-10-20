import type {
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  AgentExecutionMetadata,
  AgentExecutionOptions,
  AgentProvider,
  AgentExecution,
} from './types.js';
import { COMMON_TOKEN_USAGE, parseTokenUsage } from './token-usage.js';

/** Shared execution boundary for command-based agent providers. */
export abstract class ProcessAgentProvider implements AgentProvider {
  abstract readonly name: AgentProvider['name'];
  abstract readonly capabilities: AgentProvider['capabilities'];

  abstract buildCommand(options: AgentCommandOptions): AgentCommand;

  /**
   * The stream-json protocol the command providers share.
   *
   * A line that is not JSON is the agent's text, a `usage` event carries the
   * tokens, and a `result` event carries the answer. A provider that speaks
   * another protocol overrides this.
   *
   * A usage event whose payload holds no number is not a usage event: the
   * tokens are reported by reading the payload, not by believing it, and a
   * payload read by a cast reaches the token budget with its total missing.
   */
  parseLine(line: string): AgentEvent[] {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.type === 'usage' && parsed.usage) {
        const usage = parseTokenUsage(parsed.usage, COMMON_TOKEN_USAGE);
        if (usage) return [{ type: 'usage', usage }];
      }
      if (parsed?.type === 'result') {
        return [{ type: 'result', result: parsed.result }];
      }
    } catch {
      // Not JSON — text
    }
    return [{ type: 'text', text: line }];
  }

  async createExecution(options: AgentExecutionOptions): Promise<AgentExecution> {
    return options.sandbox.startAgent({
      command: this.buildCommand({ ...options, goal: options.prompt }),
      generation: options.generation,
      prompt: options.prompt,
      signalType: options.signalType,
      executionMode: options.executionMode,
      metadata: this.executionMetadata(options),
      parseLine: this.parseLine.bind(this),
    });
  }

  protected executionMetadata(_options: AgentExecutionOptions): AgentExecutionMetadata {
    return { provider: this.name, transport: 'process' };
  }
}
