import { compileTemplate, type CompiledAgentStep, type CompiledSystemStep } from '../../domain/templates/compiler.js';
import { selectRunnable } from '../../domain/templates/runnability.js';
import type { StepResult, WorkflowTemplate } from '../../domain/templates/types.js';

export interface PlanExecutorOptions {
  executeAgent(step: CompiledAgentStep, results: Record<string, StepResult>): Promise<StepResult>;
  executeSystem(step: CompiledSystemStep, results: Record<string, StepResult>): Promise<StepResult>;
  systemActions?: Iterable<string>;
}

/** Dependency/condition orchestration only; resource and agent details stay outside. */
export class PlanExecutor {
  constructor(private readonly options: PlanExecutorOptions) {}

  async execute(template: WorkflowTemplate): Promise<Record<string, StepResult>> {
    const plan = compileTemplate(template, { systemActions: this.options.systemActions });
    const results: Record<string, StepResult> = {};
    for (const group of plan.groups) {
      // The runnability rule owns both gates — the dependency gate and the
      // condition gate — so a step whose prerequisite never ran cannot be let
      // through by a `when` clause that happens to name it.
      const runnable = selectRunnable(group.steps, results);
      const completed = await Promise.all(runnable.map(step => step.kind === 'agent'
        ? this.options.executeAgent(step, results)
        : this.options.executeSystem(step, results)));
      for (const result of completed) results[result.stepId] = result;
      // Do not stop here: templates may intentionally gate recovery steps on
      // a failed dependency (for example review -> fix).
    }
    return results;
  }
}
