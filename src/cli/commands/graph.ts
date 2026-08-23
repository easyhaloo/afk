import { Command } from 'commander';
import { generateWorkflowGraph, type WorkflowGraphFormat } from '../../application/visualizations/workflow-graph';
import { writeGraphCache } from '../../application/visualizations/graph-cache';

const formats: WorkflowGraphFormat[] = ['json', 'archify-json'];

export function registerGraphCommands(program: Command): void {
  const graph = program.command('graph').description('Generate derived workflow graph artifacts');
  graph.command('workflow')
    .description('Generate a deterministic workflow graph')
    .argument('<template>', 'Workflow template name')
    .option('--project <path>', 'Workspace root', process.cwd())
    .option('--format <format>', 'Output format (json|archify-json)', 'json')
    .option('--output <path>', 'Cache directory or workspace-relative output directory')
    .option('--validate', 'Exit with failure when graph diagnostics contain errors')
    .action(async (template: string, options) => {
      if (!formats.includes(options.format)) throw new Error(`invalid graph format: ${options.format}`);
      const result = await generateWorkflowGraph({ projectRoot: options.project, template });
      const cache = await writeGraphCache(options.project, result, options.format, options.output);
      const payload = options.format === 'archify-json' ? result.archify : result.snapshot;
      if (options.validate && result.diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
        console.log(JSON.stringify({ ...payload, diagnostics: result.diagnostics }, null, 2));
        process.exitCode = 1;
        return;
      }
      console.log(JSON.stringify({ ...payload, cache }, null, 2));
    });
  graph.action(() => graph.outputHelp());
}
