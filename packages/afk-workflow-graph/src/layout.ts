import type { GraphEdge, GraphNode, GraphSnapshot, GraphStep, GraphTrack, Rect, WorkflowGraphDefinition, WorkflowGraphPreferences } from './ir.js';
import { normalizeDefinition } from './normalize.js';
import { routeEdges } from './routing.js';

export const workflowNodeSize = { width: 220, height: 76 } as const;
const defaults = { columnGap: 100, rowGap: 28, trackGap: 48, margin: 32 } as const;

function depthOf(step: GraphStep, byId: ReadonlyMap<string, GraphStep>, memo: Map<string, number>, visiting = new Set<string>()): number {
  if (memo.has(step.id)) return memo.get(step.id)!;
  if (visiting.has(step.id)) return 0;
  visiting.add(step.id);
  const depth = step.dependsOn.reduce((max, dependency) => {
    const parent = byId.get(dependency);
    return parent ? Math.max(max, depthOf(parent, byId, memo, visiting) + 1) : max;
  }, 0);
  visiting.delete(step.id);
  memo.set(step.id, depth);
  return depth;
}

export function layoutWorkflow(definition: WorkflowGraphDefinition, preferences: WorkflowGraphPreferences = {}): GraphSnapshot {
  const normalized = normalizeDefinition(definition);
  const nodeWidth = preferences.nodeWidth ?? workflowNodeSize.width;
  const nodeHeight = preferences.nodeHeight ?? workflowNodeSize.height;
  const columnGap = preferences.columnGap ?? defaults.columnGap;
  const rowGap = preferences.rowGap ?? defaults.rowGap;
  const trackGap = preferences.trackGap ?? defaults.trackGap;
  const margin = preferences.margin ?? defaults.margin;
  const byId = new Map(normalized.steps.map((step) => [step.id, step]));
  const depths = new Map<string, number>();
  normalized.steps.forEach((step) => depthOf(step, byId, depths));
  const maxDepth = Math.max(0, ...depths.values());
  const tracksByKey = new Map<string, GraphTrack>();
  const trackFor = (step: GraphStep): GraphTrack => {
    const key = step.when ? 'conditional' : 'default';
    const existing = tracksByKey.get(key);
    if (existing) return existing;
    const track: GraphTrack = { id: `track-${key}`, label: step.when ? 'Conditional' : 'Workflow', kind: step.when ? 'conditional' : 'default' };
    tracksByKey.set(key, track);
    return track;
  };
  const rowCountByDepth = new Map<number, number>();
  const nodes: GraphNode[] = normalized.order.map((id) => {
    const step = byId.get(id)!;
    const depth = depths.get(id) ?? 0;
    const row = rowCountByDepth.get(depth) ?? 0;
    rowCountByDepth.set(depth, row + 1);
    const track = trackFor(step);
    return {
      id: `node-${step.id}`,
      stepId: step.id,
      label: step.label ?? step.id,
      kind: step.kind ?? 'agent',
      ...(step.role === undefined ? {} : { role: step.role }),
      ...(step.provider === undefined ? {} : { provider: step.provider }),
      ...(step.action === undefined ? {} : { action: step.action }),
      trackId: track.id,
      bounds: { x: margin + depth * (nodeWidth + columnGap), y: margin + row * (nodeHeight + rowGap), width: nodeWidth, height: nodeHeight },
      ...(step.metadata === undefined ? {} : { metadata: step.metadata }),
    };
  });
  const edges: GraphEdge[] = normalized.steps.flatMap((step) => step.dependsOn.filter((dependency) => byId.has(dependency)).map((dependency) => ({
    id: `edge-${dependency}-${step.id}`,
    source: `node-${dependency}`,
    target: `node-${step.id}`,
    kind: step.when ? 'conditional' : 'dependency',
    ...(step.when ? { label: `${step.when.step} = ${step.when.equals}` } : {}),
  })));
  const rowCount = Math.max(1, ...rowCountByDepth.values());
  const bounds: Rect = { x: 0, y: 0, width: margin * 2 + (maxDepth + 1) * nodeWidth + maxDepth * columnGap, height: margin * 2 + rowCount * nodeHeight + (rowCount - 1) * rowGap };
  const base: GraphSnapshot = { schemaVersion: 1, kind: 'workflow', nodes, edges, tracks: [...tracksByKey.values()], bounds, diagnostics: normalized.diagnostics };
  return routeEdges(base, { trackGap });
}
