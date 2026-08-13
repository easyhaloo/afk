/**
 * When-clause evaluator — evaluates a single-step conditional against the
 * results of prior steps. Grammar is intentionally minimal (see types.ts):
 *
 *   { step: 'review', equals: 'completed' }   -> true iff review.status === 'completed'
 *   { step: 'review', notEquals: 'failed' }   -> true iff review.status !== 'failed'
 *
 * Returns true when the clause is satisfied OR when the referenced step has
 * not run yet (dependency resolution handles ordering separately).
 */

import type { StepResult, WhenClause } from './types';

export function evaluateWhen(clause: WhenClause | undefined, results: Record<string, StepResult>): boolean {
  if (!clause) return true;
  const r = results[clause.step];
  // If the step hasn't run yet, the when-clause is treated as satisfied —
  // the runner will re-evaluate when the step completes. This avoids the
  // chicken-and-egg of "depends on a step whose gate depends on it".
  if (!r) return true;
  if (clause.equals !== undefined) return r.status === clause.equals;
  if (clause.notEquals !== undefined) return r.status !== clause.notEquals;
  // Schema validation guarantees at least one of equals/notEquals is present.
  return true;
}