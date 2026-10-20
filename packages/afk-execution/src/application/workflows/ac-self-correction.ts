/**
 * The acceptance-criteria self-correction loop's seam.
 *
 * The loop starts from the plan's acceptance-criteria step — the one that
 * speaks the AC protocol in the verification phase — and re-runs the plan's
 * implementation step with the failed criteria, then the acceptance step
 * again. The plan says which steps those are; nothing here knows a step id.
 */

import { planSteps, selectAcVerificationStep, type CompiledAgentStep, type CompiledExecutionPlan } from '../../domain/templates/compiler.js';
import type { StepResult } from '../../domain/templates/types.js';

export interface FailedAcVerification {
  /** The step that verifies the acceptance criteria. */
  step: CompiledAgentStep;
  /** The result that failed. */
  result: StepResult;
}

/**
 * The failed acceptance-criteria step of a finished plan. A plan that
 * declares no acceptance-criteria step has nothing to correct, and a step
 * that succeeded has nothing to correct it with.
 */
export function findFailedAcVerification(
  plan: CompiledExecutionPlan,
  results: Record<string, StepResult>,
): FailedAcVerification | undefined {
  const step = selectAcVerificationStep(planSteps(plan));
  if (!step) return undefined;
  const result = results[step.id];
  if (!result || result.status !== 'failed') return undefined;
  return { step, result };
}
