/**
 * The shapes a workflow graph can be written in.
 *
 * The command that writes the graph, the cache that keeps it and the
 * desktop that shows it all have to name the same formats: a format the
 * command can produce and the desktop cannot read is a format the product
 * only half offers. The list lives in the core package because the
 * desktop's renderer reads it.
 */
export const WORKFLOW_GRAPH_FORMATS = ['json', 'archify-json'] as const;

export type WorkflowGraphFormat = (typeof WORKFLOW_GRAPH_FORMATS)[number];
