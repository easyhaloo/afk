/**
 * Runnability rule — the single place that decides whether a step runs.
 *
 * Two gates decide this, and they used to live in two files with an
 * ambiguous precedence between them:
 *
 *   1. the dependency gate  — a step normally runs only after every step it
 *      depends on completed;
 *   2. the condition gate   — a step carrying a `when` clause runs only when
 *      that clause holds for the step it names.
 *
 * The old precedence was "a `when` clause wins": the condition gate replaced
 * the dependency gate entirely, and a clause whose referenced step had no
 * recorded outcome counted as satisfied. Composed, a step whose prerequisite
 * was filtered out — so it never ran and never produced a result — still let
 * its dependent through. In the shipped `issue-implementation` template a
 * failed implementation therefore reached `publish`, which pushed the failed
 * branch and moved the backlog to verification.
 *
 * The rule now:
 *
 *   - a clause is satisfied only by a recorded outcome. A step that never ran
 *     satisfies nothing, because "no result" is not an outcome;
 *   - a dependency must have run. A dependency that never ran leaves the
 *     precondition unmet;
 *   - a dependency that ran but did not complete is tolerated only by the
 *     step that explicitly claims it: the step's own clause must name that
 *     dependency and match its outcome. That is the recovery case
 *     (`review` -> `fix`), and it stays narrow on purpose.
 *
 * Ordering removes the ambiguity that made "no result" ambiguous in the
 * first place: the resolver places a step after the step its clause names,
 * so by the time a step is evaluated every step it refers to has already
 * run — or has been excluded, and then it has no result on purpose.
 */

import type { StepResult, WhenClause } from './types.js';

export interface RunnableStep {
  id: string;
  dependsOn?: string[];
  when?: WhenClause;
}

/**
 * Does a recorded outcome satisfy the clause?
 *
 * The schema guarantees at least one of equals/notEquals is present.
 */
export function clauseMatches(clause: WhenClause, status: StepResult['status']): boolean {
  if (clause.equals !== undefined) return status === clause.equals;
  if (clause.notEquals !== undefined) return status !== clause.notEquals;
  return true;
}

/**
 * Does the step explicitly claim this dependency's outcome?
 *
 * A step may recover from a failed prerequisite only by naming that
 * prerequisite in its own clause. A clause about an unrelated step does not
 * grant a blanket waiver.
 */
export function claimsDependency(step: RunnableStep, dependency: string, status: StepResult['status']): boolean {
  const clause = step.when;
  if (!clause || clause.step !== dependency) return false;
  return clauseMatches(clause, status);
}

/**
 * The one rule: may this step run, given the results so far?
 */
export function isStepRunnable(step: RunnableStep, results: Record<string, StepResult>): boolean {
  if (step.when) {
    const referenced = results[step.when.step];
    // No recorded outcome means the referenced step never ran. It can never
    // satisfy a clause, so the step stays out.
    if (!referenced) return false;
    if (!clauseMatches(step.when, referenced.status)) return false;
  }
  for (const dependency of step.dependsOn ?? []) {
    const outcome = results[dependency];
    // A dependency that never ran leaves the precondition unmet.
    if (!outcome) return false;
    if (outcome.status !== 'completed' && !claimsDependency(step, dependency, outcome.status)) return false;
  }
  return true;
}

/**
 * The runnable subset of a group, in declaration order.
 */
export function selectRunnable<T extends RunnableStep>(steps: readonly T[], results: Record<string, StepResult>): T[] {
  return steps.filter(step => isStepRunnable(step, results));
}
