/**
 * The kinds a workflow step can be.
 *
 * The list is named because the audit spine records a step's kind, the
 * template schema validates one, the application projects one and the
 * desktop reads one. Each of them had its own copy, and the desktop's
 * two readers refused a kind the others accepted.
 *
 * The list lives in the core package because the audit spine is there,
 * and the audit spine is the record every other answer is read from.
 */
export const WORKFLOW_STEP_KINDS = ['agent', 'system'] as const;

export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

/** Whether a value names a kind a workflow step can be. */
export function isWorkflowStepKind(value: unknown): value is WorkflowStepKind {
  return typeof value === 'string' && (WORKFLOW_STEP_KINDS as readonly string[]).includes(value);
}
