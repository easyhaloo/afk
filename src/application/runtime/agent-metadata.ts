import type { AgentExecutionMetadata, AgentProviderName, AgentRuntimeSelection } from '../../domain/agents/types';
import type { TaskRuntimeRecord } from './task-runtime';

type AgentRuntimeFields = Pick<
  TaskRuntimeRecord,
  'agentTransport' | 'agentAuth' | 'agentModelProvider' | 'agentThreadId'
>;

export function runtimeFieldsFromSelection(
  provider: AgentProviderName,
  runtime?: AgentRuntimeSelection,
): AgentRuntimeFields {
  if (provider === 'codex' && runtime?.kind === 'codex') {
    return {
      agentTransport: runtime.transport,
      agentAuth: runtime.auth,
      agentModelProvider: runtime.provider,
    };
  }
  return { agentTransport: 'process' };
}

export function runtimeFieldsFromExecution(metadata: AgentExecutionMetadata): AgentRuntimeFields {
  return {
    agentTransport: metadata.transport,
    ...(metadata.auth ? { agentAuth: metadata.auth } : {}),
    ...(metadata.modelProvider ? { agentModelProvider: metadata.modelProvider } : {}),
    ...(metadata.threadId ? { agentThreadId: metadata.threadId } : {}),
  };
}
