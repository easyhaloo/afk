/**
 * Workflow template schema (docs/architecture/execution.md §10 / §12 阶段 7).
 *
 * Templates are YAML documents with steps. Each step has:
 *   id          unique within the template
 *   role        agent role (implementer / reviewer / planner / custom)
 *   prompt      either inline text OR a path to a Markdown file
 *   phase       behaviour phase — implementation | verification
 *   completionKind  completion protocol — task | qa | ac
 *   branch      BranchStrategyConfig (defaults to { type: 'issue', iid: <run.iid> })
 *   dependsOn   step IDs that must complete first
 *   when        conditional clause — if absent, step always runs
 *   parallel    optional group ID — steps with the same group ID run together
 *   timeoutMs   optional per-step timeout
 *
 * Acceptance per the design:
 *   "模板能表达依赖、条件、执行模式、Agent、分支策略和结构化输出"
 */

import { AGENT_EXECUTION_MODES, AGENT_PROVIDER_NAMES } from '@afk/core';
import { z } from 'zod';

// ── Branch strategy (re-exported from branches module) ─────────────────────
// We define a Zod schema here rather than depending on the branches module's
// TS types so the YAML is validated end-to-end at load time.

const BranchStrategyConfigSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('issue'), iid: z.number().int().positive() }),
  z.object({ type: z.literal('named'), branch: z.string().min(1), baseBranch: z.string().optional() }),
  z.object({ type: z.literal('merge-to-head'), baseBranch: z.string().optional() }),
  z.object({ type: z.literal('existing'), branch: z.string().min(1), worktreePath: z.string().optional() }),
]);

// ── When-clause ────────────────────────────────────────────────────────────
// Grammar (deliberately minimal; the design does not specify a full DSL):
//   { step: <stepId>, equals: 'completed' | 'failed' | 'aborted' }
//   { step: <stepId>, notEquals: 'failed' }
// Anything more elaborate should be expressed by chaining steps with
// dependsOn + when.

const WhenClauseSchema = z.object({
  step: z.string().min(1),
  equals: z.enum(['completed', 'failed', 'aborted', 'timed_out']).optional(),
  notEquals: z.enum(['completed', 'failed', 'aborted', 'timed_out']).optional(),
}).refine(
  (v) => v.equals !== undefined || v.notEquals !== undefined,
  { message: 'when clause must specify equals or notEquals' },
);

// ── Step behaviour vocabulary ──────────────────────────────────────────────

/**
 * The behaviour phase a step runs in.
 *
 * The phase is what the runner selects behaviour by: an implementation-phase
 * step receives the rework record and the AC correction context, a
 * verification-phase step does not, and the observation spine records the
 * step under the phase it declares.
 *
 * This is not the runner's phase *loop* (the send-goal/poll cycle that
 * `PhaseResult` reports) and not the observation spine's `RunPhase`, which
 * also knows 'release'.
 */
export const StepPhaseSchema = z.enum(['implementation', 'verification']);

/**
 * The completion protocol a step speaks.
 *
 *   task — the agent reports a plain goal completion with a summary
 *   qa   — the agent reports QA evidence (PASS/FAIL plus required checks)
 *   ac   — the agent reports acceptance-criteria verification (PASS/FAIL
 *          plus the criteria that failed)
 *
 * The completion *kind* is the protocol. It is not the signal *type*: the
 * signal type is the `goal_complete` marker every protocol shares, and it
 * stays a separate field on the step.
 */
export const StepCompletionKindSchema = z.enum(['task', 'qa', 'ac']);

// ── Step ───────────────────────────────────────────────────────────────────

const PromptSchema = z.union([
  z.string().min(1),                                   // inline text
  z.object({ file: z.string().min(1) }),                // path to .md
]);

export const StepSchema = z.object({
  id: z.string().min(1).regex(/^[a-z0-9-]+$/, 'step id must be kebab-case'),
  /** Omitted means legacy v1 agent step. */
  kind: z.enum(['agent', 'system']).optional(),
  role: z.string().min(1).optional(),
  prompt: PromptSchema.optional(),
  /** System actions are deliberately enumerated by the compiler. */
  action: z.string().min(1).optional(),
  /**
   * The signal type the step's agent emits. Every protocol uses the same
   * `goal_complete` marker, so this field never changed meaning and never
   * will: the *protocol* is declared by `completionKind` instead.
   */
  completion: z.literal('goal_complete').optional(),
  /**
   * The behaviour phase. Optional, so a template written before the phase
   * existed still validates; the compiler resolves an absent phase through
   * the legacy derivation.
   */
  phase: StepPhaseSchema.optional(),
  /**
   * The completion protocol. Optional, for the same reason as `phase`: the
   * compiler resolves an absent kind through the legacy derivation.
   */
  completionKind: StepCompletionKindSchema.optional(),
  provider: z.enum(AGENT_PROVIDER_NAMES).optional(),
  executionMode: z.enum(AGENT_EXECUTION_MODES).optional(),
  branch: BranchStrategyConfigSchema.optional(),
  dependsOn: z.array(z.string()).optional(),
  when: WhenClauseSchema.optional(),
  /** Steps sharing the same `parallel` group id run concurrently. */
  parallel: z.string().optional(),
  /** Per-step timeout; defaults to the runner's hard timeout. */
  timeoutMs: z.number().int().positive().optional(),
}).superRefine((step, ctx) => {
  if (step.kind === 'system') {
    if (!step.action) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'system step requires action', path: ['action'] });
    return;
  }
  if (!step.role) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'agent step requires role', path: ['role'] });
  if (!step.prompt) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'agent step requires prompt', path: ['prompt'] });
});

// ── Template ───────────────────────────────────────────────────────────────

export const WorkflowTemplateSchema = z.object({
  name: z.string().min(1).regex(/^[a-z0-9-]+$/, 'template name must be kebab-case'),
  version: z.literal(1),
  description: z.string().optional(),
  /** Default branch strategy for steps that don't specify their own. */
  defaultBranch: BranchStrategyConfigSchema.optional(),
  /** Default agent provider for steps. */
  defaultProvider: z.enum(AGENT_PROVIDER_NAMES).optional(),
  steps: z.array(StepSchema).min(1),
});

/** Inferred TS types from the Zod schemas. */
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;
export type Step = z.infer<typeof StepSchema>;
export type WhenClause = z.infer<typeof WhenClauseSchema>;
export type TemplateBranchStrategyConfig = z.infer<typeof BranchStrategyConfigSchema>;
export type StepPhase = z.infer<typeof StepPhaseSchema>;
export type StepCompletionKind = z.infer<typeof StepCompletionKindSchema>;

/** Runtime step result — what the runner produces for each step. */
export type StepStatus = 'completed' | 'failed' | 'aborted' | 'timed_out' | 'skipped';

export interface StepResult {
  stepId: string;
  status: StepStatus;
  /** Provider-native summary (e.g., handoff-ready summary). */
  summary?: string;
  /** Branch + worktree path used by the step. */
  branch?: string;
  worktreePath?: string;
  /** Free-form structured output for downstream when-clause inspection. */
  output?: unknown;
  startedAt: string;
  completedAt: string;
}

/** Errors raised by template machinery. */
export class TemplateError extends Error {
  constructor(message: string, public readonly templateName?: string, public readonly cause?: unknown) {
    super(templateName ? `[${templateName}] ${message}` : message);
    this.name = 'TemplateError';
  }
}
