import type {
  AgentCommand,
  AgentCommandOptions,
  AgentEvent,
  AgentExecutionMetadata,
  AgentExecutionOptions,
  AgentPromptLimits,
  AgentProvider,
  AgentExecution,
} from './types.js';
import { measurePromptBudget, PromptBudgetExceededError } from './prompt-budget.js';

/** Shared execution boundary for command-based agent providers. */
export abstract class ProcessAgentProvider implements AgentProvider {
  abstract readonly name: AgentProvider['name'];
  abstract readonly capabilities: AgentProvider['capabilities'];

  /**
   * The limits this provider declares.
   *
   * A provider that knows its own limits declares them here; one that does
   * not is measured against the strictest limit AFK knows of.
   */
  readonly promptLimits?: AgentPromptLimits;

  abstract buildCommand(options: AgentCommandOptions): AgentCommand;
  parseLine?(line: string): AgentEvent[];

  async createExecution(options: AgentExecutionOptions): Promise<AgentExecution> {
    this.assertExecutionProfile(options);
    // A goal the provider would refuse is refused here, where the reason is
    // still known. Dispatching it would cost the whole idle timeout and
    // produce a timeout instead of a cause.
    const budget = measurePromptBudget({ prompt: options.prompt, limits: this.promptLimits });
    if (budget.exceeded) throw new PromptBudgetExceededError(budget);
    return options.sandbox.startAgent({
      command: this.buildCommand({ ...options, goal: options.prompt }),
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

  protected assertExecutionProfile(options: AgentCommandOptions): void {
    if (options.executionProfile === 'analysis' && !this.capabilities.has('analysis')) {
      throw new Error(`analysis_unsupported: ${this.name}`);
    }
  }
}
