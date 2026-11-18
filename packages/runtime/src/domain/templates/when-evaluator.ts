/**
 * When-clause evaluator — evaluates a single-step conditional against the
 * results of prior steps. Grammar is intentionally minimal (see types.ts):
 *
 *   { step: 'review', equals: 'completed' }   -> true iff review.status === 'completed'
 *   { step: 'review', notEquals: 'failed' }   -> true iff review.status !== 'failed'
 */

import type { StepResult, WhenClause } from './types.js';

export function evaluateWhen(clause: WhenClause | undefined, results: Record<string, StepResult>): boolean {
  if (!clause) return true;
  if (!Object.hasOwn(results, clause.step)) return false;
  const r = results[clause.step];
  if (!r) return false;
  if (clause.equals !== undefined) return r.status === clause.equals;
  if (clause.notEquals !== undefined) return r.status !== clause.notEquals;
  // Schema validation guarantees at least one of equals/notEquals is present.
  return true;
}
