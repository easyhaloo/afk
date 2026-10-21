import type { AgentProvider, AgentRuntimeSelection, AgentExecutionMode } from '../../domain/agents/types.js';
import type { Sandbox, AgentExecution } from '../../domain/sandbox/types.js';
import type { SessionStoreChain } from '../sessions/types.js';
import { logger } from '@afk/infrastructure';

export interface ResumeContext {
  iid: number;
  session: string;
  wtPath: string;
  runId: string;
  generation: number;
  signalType: 'goal_complete';
  prompt: string;
  executionMode?: AgentExecutionMode;
  runtime?: AgentRuntimeSelection;
}

export async function attemptNativeResume(
  ctx: ResumeContext,
  agentProvider: AgentProvider,
  sandbox: Sandbox,
  chainFactory: () => SessionStoreChain,
  beforeStart: () => Promise<void>,
): Promise<AgentExecution | undefined> {
  if (!agentProvider.capabilities.has('resume')) return undefined;
  try {
    const outcome = await chainFactory().loadFirst({ runId: ctx.runId });
    if (outcome.status === 'corrupt') {
      logger.warn({ iid: ctx.iid, runId: ctx.runId, error: outcome.error }, 'native session is corrupt; starting fresh');
      return undefined;
    }
    if (outcome.status === 'missing') return undefined;
    await agentProvider.restoreSession!({ snapshot: outcome.snapshot, worktreePath: ctx.wtPath });
  } catch (error) {
    logger.info({ iid: ctx.iid, runId: ctx.runId, error }, 'native resume unavailable; falling through to coordinator');
    return undefined;
  }

  await beforeStart();
  try {
    return await agentProvider.createExecution({
      sandbox,
      worktreePath: ctx.wtPath,
      sessionId: ctx.session,
      generation: ctx.generation,
      prompt: ctx.prompt,
      signalType: ctx.signalType,
      executionMode: ctx.executionMode,
      runtime: ctx.runtime,
    });
  } catch (error) {
    logger.info({ iid: ctx.iid, runId: ctx.runId, error }, 'native resume start failed; falling through to coordinator');
    return undefined;
  }
}
