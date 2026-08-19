/**
 * Native session resume — extracted from WorkflowRunner.runPhase's context_high block.
 *
 * Architecture note: this function is a pure extraction with no new behavior.
 * It encapsulates the Phase 4 native-resume logic that was previously inlined
 * in runPhase (lines 896–942). The 'continued' return value carries an implicit
 * caller obligation: the calling phase loop must reassign its `execution` and
 * `result` bindings to the resumed values before continuing.
 *
 * Budget mutations (`budget.used++`, `budget.tokens +=`) are applied as side
 * effects on the caller's shared `budget` object — this mirrors the original
 * behavior and is the only reasonable interface given the loop's local bindings.
 */
import type { AgentProvider, AgentRuntimeSelection, SessionSnapshot, ExecutionMode } from '../../domain/agents/types';
import type { Sandbox, AgentExecution, ExecutionResult } from '../../infrastructure/sandbox/types';
import type { SessionStoreChain } from '../sessions/types';
import { logger } from '../../infrastructure/io/index';
import type { BudgetManager } from './budget';

export interface ResumeContext {
  iid: number;
  session: string;
  wtPath: string;
  runId: string;
  generation: number;
  completionTimeoutMs: number;
  contextHighTokens: number;
  signalType: 'goal_complete';
  prompt: string;
  /** Token count that triggered the outer context_high — used for budget accounting. */
  triggerTokens: number;
  /** Execution mode for the resumed execution. */
  executionMode?: ExecutionMode;
  runtime?: AgentRuntimeSelection;
}

export type ResumeOutcome =
  | { status: 'completed' }
  | { status: 'continued'; resumedExecution: AgentExecution; resumeResult: ExecutionResult }
  | { status: 'failed' };

/**
 * Attempt to resume the agent from a session snapshot.
 *
 * @param ctx          - Resume-specific context (runId, generation, prompt, triggerTokens)
 * @param budget       - Shared mutable budget object; mutated on 'continued' and 'failed' path budget accounting is done by caller
 * @param agentProvider - Must have 'resume' capability
 * @param sandbox      - The active sandbox
 * @param chainFactory - Factory for SessionStoreChain (called lazily)
 * @param captureSession - Per-execution callback to capture session state
 * @returns ResumeOutcome — caller must inspect .status and apply reassignments per variant:
 *   'completed' -> return true from runPhase
 *   'continued' -> reassign outer (execution, result) to (resumedExecution, resumeResult) and continue
 *   'failed'    -> fall through to HandoffCoordinator
 */
export async function attemptNativeResume(
  ctx: ResumeContext,
  budget: BudgetManager,
  agentProvider: AgentProvider,
  sandbox: Sandbox,
  chainFactory: () => SessionStoreChain,
  captureSession: () => Promise<SessionSnapshot | undefined>,
): Promise<ResumeOutcome> {
  // Capability check is the gate — must be checked before entering resume logic.
  if (!agentProvider.capabilities.has('resume')) {
    return { status: 'failed' };
  }

  const chain = chainFactory();

  let snapshotResult: { snapshot: SessionSnapshot; storeName: string } | null = null;
  try {
    snapshotResult = await chain.loadFirst({ runId: ctx.runId });
  } catch {
    // loadFirst throws only on corruption (not SessionNotFoundError, which returns null).
    // Surface corruption to the caller rather than silently falling through.
    return { status: 'failed' };
  }

  if (!snapshotResult) {
    return { status: 'failed' };
  }

  const { snapshot, storeName } = snapshotResult;
  logger.info({ iid: ctx.iid, runId: ctx.runId, storeName }, 'native resume: snapshot found in store chain');

  try {
    await agentProvider.restoreSession!({
      snapshot,
      worktreePath: ctx.wtPath,
    });
  } catch (err) {
    logger.info({ iid: ctx.iid, runId: ctx.runId, err: err instanceof Error ? err.message : err }, 'native resume: restoreSession failed; falling through to coordinator');
    return { status: 'failed' };
  }

  let resumed: AgentExecution;
  try {
    resumed = await agentProvider.createExecution({
      sandbox,
      worktreePath: ctx.wtPath,
      sessionId: ctx.session,
      generation: ctx.generation,
      prompt: ctx.prompt,
      signalType: ctx.signalType,
      executionMode: ctx.executionMode,
      runtime: ctx.runtime,
    });
  } catch (err) {
    logger.info({ iid: ctx.iid, runId: ctx.runId, err: err instanceof Error ? err.message : err }, 'native resume: startAgent failed; falling through to coordinator');
    return { status: 'failed' };
  }

  // Budget accounting is applied here (once per resume round), not by the caller.
  budget.record(ctx.triggerTokens);

  let resumeResult: ExecutionResult;
  try {
    resumeResult = await resumed.waitForResult({
      completionTimeoutMs: ctx.completionTimeoutMs,
      contextHighTokens: ctx.contextHighTokens,
    });
  } catch (err) {
    logger.info({ iid: ctx.iid, runId: ctx.runId, err: err instanceof Error ? err.message : err }, 'native resume: waitForResult threw; falling through to coordinator');
    return { status: 'failed' };
  }

  if (resumeResult.status === 'completed') {
    return { status: 'completed' };
  }

  if (resumeResult.status === 'context_high') {
    // Token accounting already done above; signal 'continued' so the caller
    // reassigns execution/result and loops back to re-check budget.
    logger.info({ iid: ctx.iid, runId: ctx.runId }, 'native resume: agent hit context_high again; looping');
    return { status: 'continued', resumedExecution: resumed, resumeResult };
  }

  // 'timed_out', 'failed', 'aborted' — fall through to coordinator.
  logger.info({ iid: ctx.iid, runId: ctx.runId, status: resumeResult.status }, 'native resume returned non-continue status; falling through to coordinator');
  return { status: 'failed' };
}
