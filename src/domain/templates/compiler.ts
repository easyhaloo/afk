import { resolveExecutionPlan } from './resolver';
import type { ExecutionPlan } from './resolver';
import { TemplateError, type Step, type WorkflowTemplate } from './types';

export const BUILTIN_SYSTEM_ACTIONS = ['publish-change', 'queue-qa'] as const;
export type BuiltinSystemAction = typeof BUILTIN_SYSTEM_ACTIONS[number];

export interface CompiledAgentStep extends Omit<Step, 'kind' | 'role' | 'prompt' | 'completion'> {
  kind: 'agent';
  role: string;
  prompt: NonNullable<Step['prompt']>;
  completionSignal: 'goal_complete';
  /** True when an existing v1 role step was normalized. */
  legacy: boolean;
}

export interface CompiledSystemStep extends Omit<Step, 'kind' | 'action'> {
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
    return { ...step, kind: 'system', action: step.action! };
  }
  if (!step.role || !step.prompt) throw new TemplateError(`agent step '${step.id}' is missing role or prompt`, templateName);
  return {
    ...step,
    kind: 'agent',
    role: step.role,
    prompt: step.prompt,
    completionSignal: 'goal_complete',
    legacy: step.kind === undefined,
  };
}

export function isBuiltinSystemAction(action: unknown): action is BuiltinSystemAction {
  return typeof action === 'string' && (BUILTIN_SYSTEM_ACTIONS as readonly string[]).includes(action);
}
