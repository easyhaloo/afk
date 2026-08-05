/**
 * Workflow template schema (EXECUTION-DESIGN.md §10 / §12 阶段 7).
 *
 * Templates are YAML documents with steps. Each step has:
 *   id          unique within the template
 *   role        agent role (implementer / reviewer / planner / custom)
 *   prompt      either inline text OR a path to a Markdown file
 *   branch      BranchStrategyConfig (defaults to { type: 'issue', iid: <run.iid> })
 *   dependsOn   step IDs that must complete first
 *   when        conditional clause — if absent, step always runs
 *   parallel    optional group ID — steps with the same group ID run together
 *   timeoutMs   optional per-step timeout
 *
 * Acceptance per the design:
 *   "模板能表达依赖、条件、执行模式、Agent、分支策略和结构化输出"
 */

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
  completion: z.literal('goal_complete').optional(),
  provider: z.enum(['claude-code', 'codex', 'cursor', 'pi', 'opencode', 'copilot']).optional(),
  executionMode: z.enum(['interactive', 'batch']).optional(),
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
  defaultProvider: z.enum([
    'claude-code', 'codex', 'cursor', 'pi', 'opencode', 'copilot',
  ]).optional(),
  steps: z.array(StepSchema).min(1),
});

/** Inferred TS types from the Zod schemas. */
export type WorkflowTemplate = z.infer<typeof WorkflowTemplateSchema>;
export type Step = z.infer<typeof StepSchema>;
export type WhenClause = z.infer<typeof WhenClauseSchema>;
export type TemplateBranchStrategyConfig = z.infer<typeof BranchStrategyConfigSchema>;

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
