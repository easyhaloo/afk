import { createReceipt, layoutWorkflow, projectWorkflow, toArchifyWorkflow, validateSnapshot, type ArchifyWorkflowDocument, type GraphReceipt, type GraphSnapshot } from '@afk/workflow-graph';
import { TemplateLoader, type LoadedTemplate } from '../../domain/templates/loader';

export type WorkflowGraphFormat = 'json' | 'archify-json';

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
  const loaded = await new TemplateLoader({ projectRoot }).loadWithSource(options.template);
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
      when: step.when && 'equals' in step.when && step.when.equals ? { step: step.when.step, equals: step.when.equals } : undefined,
      dependsOn: step.dependsOn ?? [],
      label: step.id,
    })),
  });
  const snapshot = layoutWorkflow(definition);
  const diagnostics = validateSnapshot(snapshot);
  const receipt = createReceipt(definition, snapshot, '0.1.0', options.generatedAt);
  return { template: loaded, definition, snapshot: { ...snapshot, receipt }, receipt, diagnostics, archify: toArchifyWorkflow(snapshot, definition) };
}
