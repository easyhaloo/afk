import type { GraphSnapshot, WorkflowGraphDefinition } from './ir.js';

export interface ArchifyWorkflowDocument {
  readonly schemaVersion: 1;
  readonly type: 'workflow';
  readonly meta: {
    readonly id: string;
    readonly version: number;
    readonly name: string;
    readonly quality_profile: 'showcase';
    readonly description?: string;
  };
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: string;
    readonly lane?: string;
    readonly position: { readonly x: number; readonly y: number };
    readonly size: { readonly width: number; readonly height: number };
  }[];
  readonly edges: readonly {
    readonly id: string;
    readonly source: string;
    readonly target: string;
    readonly kind: string;
    readonly label?: string;
  }[];
  readonly lanes: readonly { readonly id: string; readonly label: string }[];
}

export function toArchifyWorkflow(snapshot: GraphSnapshot, definition: WorkflowGraphDefinition): ArchifyWorkflowDocument {
  const tracks = new Map(snapshot.tracks.map((track) => [track.id, track]));
  return {
    schemaVersion: 1,
    type: 'workflow',
    meta: {
      id: definition.templateId,
      version: definition.templateVersion,
      name: definition.name,
      quality_profile: 'showcase',
      ...(definition.description === undefined ? {} : { description: definition.description }),
    },
    nodes: snapshot.nodes.map((node) => ({
      id: node.stepId,
      label: node.label,
      kind: node.kind,
      ...(tracks.get(node.trackId) ? { lane: tracks.get(node.trackId)!.label } : {}),
      position: { x: node.bounds.x, y: node.bounds.y },
      size: { width: node.bounds.width, height: node.bounds.height },
    })),
    edges: snapshot.edges.map((edge) => ({
      id: edge.id,
      source: edge.source.replace(/^node-/, ''),
      target: edge.target.replace(/^node-/, ''),
      kind: edge.kind,
      ...(edge.label === undefined ? {} : { label: edge.label }),
    })),
    lanes: snapshot.tracks.map((track) => ({ id: track.id, label: track.label })),
  };
}
