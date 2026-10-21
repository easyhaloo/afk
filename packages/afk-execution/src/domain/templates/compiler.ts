/**
 * The compiler — one template in, one plan out.
 *
 * The plan is the only shape the runtime executes: groups of steps, each step
 * carrying the decisions the runner needs — kind, phase, completion protocol,
 * provider, prompt, branch, level, dependencies, condition.
 *
 * The compilation has two halves:
 *
 *   1. the resolution — validate the references, compute the levels and group
 *      the steps by level. The order, the levels and the cycle question come
 *      from one computation: the same one the graph package and the desktop
 *      studio use.
 *   2. the step compilation — resolve each step's phase and completion
 *      protocol, including the legacy derivation from its role.
 *
 * The resolver's own plan shape is internal to this module. A caller asks for
 * a compiled plan; the intermediate one is a step on the way there.
 *
 * A step depends on its `dependsOn` steps AND on the step its `when` clause
 * names. The second edge is what makes a clause decidable: by the time a step
 * is evaluated, the step it names has already run — or has been excluded, in
 * which case it deliberately has no result. Without that edge "no result"
 * would mean both "has not run yet" and "will never run", and the two have
 * to be told apart.
 *
 * Cycles raise TemplateError.
 */

import { computeStepGraph } from '@afk/workflow-graph';
import type { WorkflowStepKind } from '@afk/core';
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

/** The plan the runtime executes. */
export interface CompiledExecutionPlan {
  templateName: string;
  groups: Array<{ level: number; steps: CompiledStep[] }>;
}

/** The resolution's own plan — a step on the way to the compiled one. */
interface ExecutionGroup {
  level: number;
  /** Steps in this group, in declaration order. */
  steps: Step[];
}

interface ExecutionPlan {
  templateName: string;
  groups: ExecutionGroup[];
}

/**
 * The steps a step waits for: its declared dependencies plus the step its
 * `when` clause names. A step named by both is one dependency, not two.
 */
function dependenciesOf(step: Step): string[] {
  const deps = new Set(step.dependsOn ?? []);
  if (step.when) deps.add(step.when.step);
  return [...deps];
}

/**
 * Resolve the template into the resolution's plan: an ordered list of
 * `groups`, where each group runs concurrently and groups run sequentially.
 *
 * Algorithm:
 *   1. Validate references (every dependsOn / when.step exists in the
 *      template).
 *   2. Compute levels via Kahn's algorithm (BFS topological sort). Each step
 *      is assigned the level = 1 + max(level(deps)).
 *   3. Group steps by level. Steps at the same level run concurrently.
 *   4. Within a level, preserve declaration order for deterministic scheduling.
 */
export function resolveExecutionPlan(template: WorkflowTemplate): ExecutionPlan {
  const validIds = new Set(template.steps.map(s => s.id));
  for (const step of template.steps) {
    if (!validIds.has(step.id)) {
      throw new TemplateError(`step id '${step.id}' not in valid set`, template.name);
    }
    for (const dep of step.dependsOn ?? []) {
      if (!validIds.has(dep)) {
        throw new TemplateError(`step '${step.id}' depends on unknown step '${dep}'`, template.name);
      }
    }
    if (step.when && !validIds.has(step.when.step)) {
      throw new TemplateError(`step '${step.id}' when-clause references unknown step '${step.when.step}'`, template.name);
    }
  }

  // Self-dependency check (cheap pre-check before Kahn's).
  for (const step of template.steps) {
    if ((step.dependsOn ?? []).includes(step.id)) {
      throw new TemplateError(`step '${step.id}' depends on itself`, template.name);
    }
    if (step.when?.step === step.id) {
      throw new TemplateError(`step '${step.id}' references itself in its when-clause`, template.name);
    }
  }

  // The order, the levels and the cycle question come from one computation —
  // the same one the graph package and the desktop studio use. This resolver
  // reports them in its own words.
  const graph = computeStepGraph(
    template.steps.map(step => ({ id: step.id, dependsOn: dependenciesOf(step) })),
  );
  if (graph.cycle) {
    throw new TemplateError(`dependency cycle detected`, template.name);
  }
  const levelByStep = graph.levels;

  // A `parallel` group is a promise that its members run together. The
  // promise used to be decoration: no module read the field, and the members
  // happened to run concurrently only because nothing made them depend on
  // each other. Now it is checked — a template that declares a parallel
  // group and then serialises it is a template whose declaration and its
  // dependencies disagree.
  const parallelLevels = new Map<string, Set<number>>();
  for (const step of template.steps) {
    if (!step.parallel) continue;
    const levels = parallelLevels.get(step.parallel) ?? new Set<number>();
    levels.add(levelByStep.get(step.id) ?? 0);
    parallelLevels.set(step.parallel, levels);
  }
  for (const [group, levels] of parallelLevels) {
    if (levels.size > 1) {
      throw new TemplateError(
        `parallel group '${group}' is split across levels (${[...levels].sort((left, right) => left - right).join(', ')}); its steps must not depend on each other`,
        template.name,
      );
    }
  }

  // Group by level.
  const maxLevel = Math.max(0, ...levelByStep.values());
  const groups: ExecutionGroup[] = [];
  for (let lvl = 0; lvl <= maxLevel; lvl++) {
    const steps = template.steps
      .filter(s => levelByStep.get(s.id) === lvl)
      // Preserve declaration order.
      .sort((a, b) => template.steps.indexOf(a) - template.steps.indexOf(b));
    groups.push({ level: lvl, steps });
  }

  return { templateName: template.name, groups };
}

/**
 * Compile a template into the plan the runtime executes: the resolution's
 * groups, with every step carrying the decisions the runner selects
 * behaviour by.
 */
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
 * How a caller names the step it wants out of a plan. A field left out
 * matches every step.
 */
export interface StepSelector {
  /** The step's id. */
  id?: string;
  /** The step's kind. */
  kind?: WorkflowStepKind;
  /** The behaviour phase. Only an agent step has one. */
  phase?: StepPhase;
  /** The completion protocol. Only an agent step has one. */
  completionKind?: StepCompletionKind;
}

/** The first step that matches the selector, in execution order. */
export function selectStep(steps: readonly CompiledStep[], selector: StepSelector): CompiledStep | undefined {
  return steps.find(step => {
    if (selector.id !== undefined && step.id !== selector.id) return false;
    if (selector.kind !== undefined && step.kind !== selector.kind) return false;
    if (selector.phase !== undefined && (step.kind !== 'agent' || step.phase !== selector.phase)) return false;
    if (selector.completionKind !== undefined && (step.kind !== 'agent' || step.completionKind !== selector.completionKind)) return false;
    return true;
  });
}

/**
 * The step that verifies the acceptance criteria: the one that speaks the AC
 * protocol in the verification phase. A plan that declares no such step has
 * no self-correction loop.
 */
export function selectAcVerificationStep(steps: readonly CompiledStep[]): CompiledAgentStep | undefined {
  const step = selectStep(steps, { kind: 'agent', phase: 'verification', completionKind: 'ac' });
  return step?.kind === 'agent' ? step : undefined;
}

/**
 * The step the self-correction loop re-runs with the AC feedback: the
 * plan's first implementation-phase step. A plan that declares no
 * implementation step has nothing to correct.
 */
export function selectImplementationStep(steps: readonly CompiledStep[]): CompiledAgentStep | undefined {
  const step = selectStep(steps, { kind: 'agent', phase: 'implementation' });
  return step?.kind === 'agent' ? step : undefined;
}
