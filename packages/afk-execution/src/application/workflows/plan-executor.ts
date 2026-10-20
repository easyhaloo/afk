import { type CompiledAgentStep, type CompiledExecutionPlan, type CompiledSystemStep } from '../../domain/templates/compiler.js';
import { selectRunnable } from '../../domain/templates/runnability.js';
import type { StepResult } from '../../domain/templates/types.js';

export interface PlanExecutorOptions {
  executeAgent(step: CompiledAgentStep, results: Record<string, StepResult>): Promise<StepResult>;
  executeSystem(step: CompiledSystemStep, results: Record<string, StepResult>): Promise<StepResult>;
}

/** Dependency/condition orchestration only; resource and agent details stay outside. */
export class PlanExecutor {
  constructor(private readonly options: PlanExecutorOptions) {}

  /**
   * Run the plan the catalogue compiled. The executor does not compile: one
   * module owns the plan, and the runner holds the compiled plan so it can
   * select behaviour from the same steps the executor runs.
   */
  async execute(plan: CompiledExecutionPlan): Promise<Record<string, StepResult>> {
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
