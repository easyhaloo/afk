import { compileTemplate, type CompiledAgentStep, type CompiledSystemStep } from '../../domain/templates/compiler';
import { evaluateWhen } from '../../domain/templates/when-evaluator';
import type { StepResult, WorkflowTemplate } from '../../domain/templates/types';

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
      const runnable = group.steps.filter(step => {
        if (!evaluateWhen(step.when, results)) return false;
        // A normal dependency means the prerequisite completed successfully.
        // A step with an explicit condition may intentionally recover from a
        // failed prerequisite (for example review -> fix).
        if (step.when) return true;
        return (step.dependsOn ?? []).every(id => results[id]?.status === 'completed');
      });
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
