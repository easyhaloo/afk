import { Command, InvalidArgumentError } from 'commander';
import { AGENT_AUTH_CHOICES, AGENT_TRANSPORT_CHOICES } from '@afk/core';
import type { AgentRuntimeSelection, AgentProviderName } from '@afk/execution/domain/agents/types';
import {
  resolveCodexRuntime,
  type CodexAuth,
  type CodexRuntimeOverrides,
  type CodexTransport,
} from '@afk/execution/domain/agents/codex-runtime';
import type { WorkflowConfig } from '@afk/execution/infrastructure/config/manager';

export interface AgentRuntimeCommandOptions {
  agentTransport?: CodexTransport;
  agentAuth?: CodexAuth;
  agentProvider?: string;
  agentProfile?: string;
  agentAppServer?: string;
  agentAppServerAuthEnv?: string;
}

export function addAgentRuntimeOptions(command: Command): Command {
  return command
    .option('--agent-transport <transport>', `Agent transport: ${AGENT_TRANSPORT_CHOICES.join(' | ')}`, enumValue('transport', AGENT_TRANSPORT_CHOICES))
    .option('--agent-auth <auth>', `Agent authentication: ${AGENT_AUTH_CHOICES.join(' | ')}`, enumValue('auth', AGENT_AUTH_CHOICES))
    .option('--agent-provider <provider>', 'Agent model provider')
    .option('--agent-profile <profile>', 'Agent host configuration profile')
    .option('--agent-app-server <endpoint>', 'Codex app-server endpoint')
    .option('--agent-app-server-auth-env <name>', 'Environment variable containing the app-server bearer token', environmentName);
}

export function resolveAgentRuntimeOptions(
  agent: AgentProviderName,
  config: WorkflowConfig,
  options: AgentRuntimeCommandOptions,
): AgentRuntimeSelection {
  if (agent !== 'codex') return { kind: 'default' };
  const cli: CodexRuntimeOverrides = {
    transport: options.agentTransport,
    auth: options.agentAuth,
    provider: options.agentProvider,
    profile: options.agentProfile,
    endpoint: options.agentAppServer,
    authTokenEnv: options.agentAppServerAuthEnv,
  };
  return resolveCodexRuntime({ cli, config: config.agents.codex });
}

function enumValue<T extends string>(label: string, values: readonly T[]): (value: string) => T {
  return value => {
    if (!values.includes(value as T)) {
      throw new InvalidArgumentError(`invalid ${label}: ${value}; expected ${values.join(' or ')}`);
    }
    return value as T;
  };
}

function environmentName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new InvalidArgumentError(`invalid environment variable name: ${value}`);
  }
  return value;
}
