import { createReceipt, layoutWorkflow, projectWorkflow, toArchifyWorkflow, validateSnapshot, type ArchifyWorkflowDocument, type GraphReceipt, type GraphSnapshot } from '@afk/workflow-graph';
import { TemplateCatalog, type LoadedTemplate } from '../../domain/templates/catalog.js';
import { WORKFLOW_GRAPH_FORMATS, type WorkflowGraphFormat } from '@afk/core';



export interface WorkflowGraphResult {
  readonly template: LoadedTemplate;
  readonly definition: ReturnType<typeof projectWorkflow>;
  readonly snapshot: GraphSnapshot;
  readonly receipt: GraphReceipt;
  readonly diagnostics: ReturnType<typeof validateSnapshot>;
  readonly archify?: ArchifyWorkflowDocument;
}

export async function generateWorkflowGraph(options: { readonly projectRoot?: string; readonly template: string; readonly generatedAt?: string }): Promise<WorkflowGraphResult> {
  const projectRoot = options.projectRoot ?? process.cwd();
  // The catalogue owns the templates and where they come from; the projection
  // asks it for the template and its source and draws what it finds.
  const loaded = await new TemplateCatalog({ projectRoot }).loadWithSource(options.template);
  const definition = projectWorkflow({
    templateId: loaded.template.name,
    templateVersion: loaded.template.version,
    name: loaded.template.name,
    description: loaded.template.description,
    steps: loaded.template.steps.map((step) => ({
      id: step.id,
      kind: step.kind === 'system' ? 'system' : 'agent',
      role: step.role,
      provider: step.provider ?? loaded.template.defaultProvider,
      action: step.action,
      when: step.when
        ? {
          step: step.when.step,
          ...(step.when.equals !== undefined ? { equals: step.when.equals } : {}),
          ...(step.when.notEquals !== undefined ? { notEquals: step.when.notEquals } : {}),
        }
        : undefined,
      dependsOn: step.dependsOn ?? [],
      label: step.id,
    })),
  });
  const snapshot = layoutWorkflow(definition);
  const diagnostics = validateSnapshot(snapshot);
  const receipt = createReceipt(definition, snapshot, '0.1.0', options.generatedAt);
  return { template: loaded, definition, snapshot: { ...snapshot, receipt }, receipt, diagnostics, archify: toArchifyWorkflow(snapshot, definition) };
}
