import { resolveExecutionPlan } from './resolver.js';
import type { ExecutionPlan } from './resolver.js';
import { deriveStepCompletionKind, deriveStepPhase } from './step-behaviour.js';
import { TemplateError, type Step, type StepCompletionKind, type StepPhase, type WorkflowTemplate } from './types.js';

export const BUILTIN_SYSTEM_ACTIONS = ['publish-change', 'queue-qa'] as const;
export type BuiltinSystemAction = typeof BUILTIN_SYSTEM_ACTIONS[number];

export interface CompiledAgentStep extends Omit<Step, 'kind' | 'role' | 'prompt' | 'completion' | 'phase' | 'completionKind'> {
  kind: 'agent';
  role: string;
  prompt: NonNullable<Step['prompt']>;
  /** The signal type the agent emits. Distinct from the completion kind. */
  completionSignal: 'goal_complete';
  /** The behaviour phase. Resolved by the compiler, so never undefined. */
  phase: StepPhase;
  /** The completion protocol. Resolved by the compiler, so never undefined. */
  completionKind: StepCompletionKind;
  /** True when an existing v1 role step was normalized. */
  legacy: boolean;
}

export interface CompiledSystemStep extends Omit<Step, 'kind' | 'action' | 'phase' | 'completionKind'> {
  kind: 'system';
  action: string;
}

export type CompiledStep = CompiledAgentStep | CompiledSystemStep;
export interface CompiledExecutionPlan extends Omit<ExecutionPlan, 'groups'> {
  groups: Array<{ level: number; steps: CompiledStep[] }>;
}

export function compileTemplate(template: WorkflowTemplate, options: { systemActions?: Iterable<string> } = {}): CompiledExecutionPlan {
  const plan = resolveExecutionPlan(template);
  return {
    templateName: plan.templateName,
    groups: plan.groups.map(group => ({ level: group.level, steps: group.steps.map(step => compileStep(step, template.name, options.systemActions)) })),
  };
}

function compileStep(step: Step, templateName: string, systemActions?: Iterable<string>): CompiledStep {
  if (step.kind === 'system') {
    if (!isBuiltinSystemAction(step.action) && ![...(systemActions ?? [])].includes(step.action ?? '')) {
      throw new TemplateError(`unknown system action '${step.action ?? ''}'`, templateName);
    }
    // A system step runs no agent, so it has no phase and no protocol.
    const { phase: _phase, completionKind: _completionKind, ...rest } = step;
    return { ...rest, kind: 'system', action: step.action! };
  }
  if (!step.role || !step.prompt) throw new TemplateError(`agent step '${step.id}' is missing role or prompt`, templateName);
  return {
    ...step,
    kind: 'agent',
    role: step.role,
    prompt: step.prompt,
    completionSignal: 'goal_complete',
    phase: deriveStepPhase(step),
    completionKind: deriveStepCompletionKind(step),
    legacy: step.kind === undefined,
  };
}

export function isBuiltinSystemAction(action: unknown): action is BuiltinSystemAction {
  return typeof action === 'string' && (BUILTIN_SYSTEM_ACTIONS as readonly string[]).includes(action);
}

/** The plan's steps, in execution order. */
export function planSteps(plan: CompiledExecutionPlan): CompiledStep[] {
  return plan.groups.flatMap(group => group.steps);
}

/**
 * The step that verifies the acceptance criteria: the one that speaks the AC
 * protocol in the verification phase. A plan that declares no such step has
 * no self-correction loop.
 */
export function selectAcVerificationStep(steps: readonly CompiledStep[]): CompiledAgentStep | undefined {
  return steps.find((step): step is CompiledAgentStep =>
    step.kind === 'agent' && step.phase === 'verification' && step.completionKind === 'ac');
}

/**
 * The step the self-correction loop re-runs with the AC feedback: the
 * plan's first implementation-phase step. A plan that declares no
 * implementation step has nothing to correct.
 */
export function selectImplementationStep(steps: readonly CompiledStep[]): CompiledAgentStep | undefined {
  return steps.find((step): step is CompiledAgentStep =>
    step.kind === 'agent' && step.phase === 'implementation');
}
