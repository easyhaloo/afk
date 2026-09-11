import { createHash } from 'node:crypto';
import type { GraphStep, GraphStepKind, WorkflowCondition, WorkflowGraphDefinition } from './ir.js';

export interface WorkflowTemplateSummary {
  readonly templateId: string;
  readonly templateVersion: number;
  readonly name: string;
  readonly description?: string;
  readonly steps: readonly (Omit<GraphStep, 'kind' | 'dependsOn'> & {
    readonly kind?: GraphStepKind;
    readonly dependsOn?: readonly string[];
    readonly when?: WorkflowCondition;
  })[];
  readonly metadata?: Readonly<Record<string, unknown>>;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function projectWorkflow(template: WorkflowTemplateSummary): WorkflowGraphDefinition {
  const steps = template.steps.map((step) => {
    const projected: GraphStep = {
      ...step,
      kind: step.kind ?? 'agent',
      dependsOn: [...(step.dependsOn ?? [])],
    };
    return { ...projected, contentHash: hash(projected) };
  });

  const definition: WorkflowGraphDefinition = {
    templateId: template.templateId,
    templateVersion: template.templateVersion,
    name: template.name,
    ...(template.description === undefined ? {} : { description: template.description }),
    steps,
    ...(template.metadata === undefined ? {} : { metadata: template.metadata }),
  };
  return definition;
}

export { canonicalJson };
