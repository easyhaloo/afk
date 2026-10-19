import type { AgentCommand, AgentCommandOptions, AgentEvent, AgentProvider } from '../../domain/agents/types';

export type CommandAgentProvider = AgentProvider & {
  buildCommand(options: AgentCommandOptions): AgentCommand;
  parseLine?(line: string): AgentEvent[];
};

export function requireCommandAgentProvider(provider: AgentProvider): CommandAgentProvider {
  if (!('buildCommand' in provider) || typeof provider.buildCommand !== 'function') {
    throw new Error(`agent provider '${provider.name}' does not support command execution`);
  }
  return provider as CommandAgentProvider;
}
