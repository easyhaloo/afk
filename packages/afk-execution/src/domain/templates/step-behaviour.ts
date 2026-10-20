/**
 * Step behaviour — the phase and the completion protocol a step runs with.
 *
 * A template declares what a step *is*; the runner needs to know what a step
 * *does*. The two used to be connected by a literal step id compared hundreds
 * of lines away from the schema that declared the template, so a template
 * that named its steps differently got the wrong protocol and never entered
 * the self-correction loop. The template now declares the decisions, and
 * this module is where a step that declares nothing is resolved.
 *
 * The legacy derivation
 * ---------------------
 * A template written before the phase and the completion kind existed
 * declares neither. Such a step is resolved from its `role`, which used to be
 * decoration:
 *
 *   role names verification  → phase 'verification', completion kind 'ac'
 *   any other role           → phase 'implementation', completion kind 'task'
 *
 * That is the behaviour the built-in templates had before the phase existed:
 * the acceptance-criteria step was the one whose role was `verifier`, and
 * every other step spoke the plain task protocol. A step that declares its
 * own phase or completion kind overrides the derivation — the declaration is
 * the stronger statement, and a step that declares only the AC protocol
 * verifies, so it lands in the verification phase.
 */

import type { Step, StepCompletionKind, StepPhase } from './types.js';

/**
 * Does the role name verification?
 *
 * The historical acceptance-criteria step was the one whose role was
 * `verifier`; a role that names verification in any spelling (`verifier`,
 * `ac-verifier`, `verification-agent`) is the same statement.
 */
export function isVerificationRole(role: string | undefined): boolean {
  return typeof role === 'string' && /verif/i.test(role);
}

/** The phase a step runs in: its own declaration, else the legacy derivation. */
export function deriveStepPhase(step: Step): StepPhase {
  if (step.phase) return step.phase;
  // A step that declares the AC protocol verifies the acceptance criteria,
  // so it verifies — whatever its role says.
  if (step.completionKind === 'ac') return 'verification';
  return isVerificationRole(step.role) ? 'verification' : 'implementation';
}

/**
 * The completion protocol a step speaks: its own declaration, else the kind
 * that belongs to its phase.
 *
 * A verification-phase step verifies acceptance criteria, so it speaks the AC
 * protocol unless it says otherwise. The QA protocol is never derived: only
 * a declaration produces it.
 */
export function deriveStepCompletionKind(step: Step): StepCompletionKind {
  if (step.completionKind) return step.completionKind;
  return deriveStepPhase(step) === 'verification' ? 'ac' : 'task';
}
