import type {
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  AgentExecutionMetadata,
  AgentExecutionOptions,
  AgentProvider,
} from './types';
import type { AgentExecution } from '../sandbox/types';

/** Shared execution boundary for command-based agent providers. */
export abstract class ProcessAgentProvider implements AgentProvider {
  abstract readonly name: AgentProvider['name'];
  abstract readonly capabilities: AgentProvider['capabilities'];

  abstract buildCommand(options: AgentCommandOptions): AgentCommand;
  parseLine?(line: string): AgentEvent[];

  async createExecution(options: AgentExecutionOptions): Promise<AgentExecution> {
    return options.sandbox.startAgent({
      command: this.buildCommand(options),
      generation: options.generation,
      prompt: options.prompt,
      signalType: options.signalType,
      executionMode: options.executionMode,
      metadata: this.executionMetadata(options),
      parseLine: this.parseLine?.bind(this),
    });
  }

  protected executionMetadata(_options: AgentExecutionOptions): AgentExecutionMetadata {
    return { provider: this.name, transport: 'process' };
  }
}
