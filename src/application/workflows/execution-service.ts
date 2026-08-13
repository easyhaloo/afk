import type { AgentProvider, ExecutionMode } from '../../domain/agents/types';
import type { ExecutionResult, Sandbox } from '../../infrastructure/sandbox/types';
import { RunStateWriter } from '../sessions/run-state';

export interface AgentStepExecutionRequest {
  provider: AgentProvider;
  sandbox: Sandbox;
  worktreePath: string;
  prompt: string;
  signalType: 'goal_complete';
  sessionId?: string;
  executionMode?: ExecutionMode;
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
      const command = request.provider.buildCommand({
        worktreePath: request.worktreePath,
        sessionId,
        goal: request.prompt,
        interactive: request.executionMode !== 'batch',
        executionMode: request.executionMode,
      });
      const execution = await request.sandbox.startAgent({
        command,
        generation: request.generation + attempt,
        prompt: request.prompt,
        signalType: request.signalType,
        executionMode: request.executionMode,
        agentProvider: request.provider,
      });
      const writer = new RunStateWriter(request.worktreePath, execution.id);
      await writer.init();
      await writer.writeRequest({
        runId: execution.id, iid: request.iid ?? 0, generation: request.generation + attempt,
        provider: request.provider.name, worktreePath: request.worktreePath, goalText: request.prompt,
        signalType: request.signalType, startedAt: new Date().toISOString(),
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
