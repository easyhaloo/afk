import type { AgentProvider, AgentRuntimeSelection, ExecutionMode } from '../agents/types';
import type { ExecutionResult, Sandbox } from '../sandbox/types';
import { RunStateWriter } from '../sessions/run-state';

export interface AgentStepExecutionRequest {
  provider: AgentProvider;
  sandbox: Sandbox;
  worktreePath: string;
  prompt: string;
  signalType: 'goal_complete';
  sessionId?: string;
  executionMode?: ExecutionMode;
  runtime?: AgentRuntimeSelection;
  generation: number;
  maxRetries: number;
  completionTimeoutMs: number;
  contextHighTokens: number;
  iid?: number;
}

/** Executes one agent step and persists diagnostics without owning resources. */
export class AgentExecutionService {
  async execute(request: AgentStepExecutionRequest): Promise<ExecutionResult> {
    let attempt = 0;
    let result: ExecutionResult | undefined;
    do {
      const sessionId = request.sessionId ?? `afk-${request.iid ?? 'run'}-${request.generation}-${attempt}`;
      const execution = await request.provider.createExecution({
        sandbox: request.sandbox,
        worktreePath: request.worktreePath,
        sessionId,
        prompt: request.prompt,
        signalType: request.signalType,
        generation: request.generation + attempt,
        interactive: request.executionMode !== 'batch',
        executionMode: request.executionMode,
        runtime: request.runtime,
      });
      const writer = new RunStateWriter(request.worktreePath, execution.id);
      await writer.init();
      await writer.writeRequest({
        runId: execution.id, iid: request.iid ?? 0, generation: request.generation + attempt,
        provider: request.provider.name, worktreePath: request.worktreePath, goalText: request.prompt,
        signalType: request.signalType, startedAt: new Date().toISOString(),
        agentTransport: execution.metadata.transport,
        agentAuth: execution.metadata.auth,
        agentModelProvider: execution.metadata.modelProvider,
        agentThreadId: execution.metadata.threadId,
      });
      result = await execution.waitForResult({
        completionTimeoutMs: request.completionTimeoutMs,
        contextHighTokens: request.contextHighTokens,
      });
      result = this.validateCompletion(result, request);
      await writer.writeResult(result);
      if (result.status !== 'failed') return result;
      attempt++;
    } while (attempt <= request.maxRetries);
    return result!;
  }

  private validateCompletion(result: ExecutionResult, request: AgentStepExecutionRequest): ExecutionResult {
    if (result.status !== 'completed' || request.executionMode !== 'batch') return result;
    const output = result.structuredOutput;
    if (!output || typeof output !== 'object' || !('type' in output) || (output as { type?: unknown }).type !== request.signalType) {
      return {
        ...result,
        status: 'failed',
        error: { code: 'SIGNAL_MISMATCH', message: `expected ${request.signalType} structured result` },
      };
    }
    return result;
  }
}
