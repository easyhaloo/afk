export type GraphSnapshot = {
  nodes: Array<{ id: string; stepId: string; label: string; kind: string; bounds: { x: number; y: number; width: number; height: number } }>;
  edges: Array<{ id: string; source: string; target: string; label?: string; route?: { points: Array<{ x: number; y: number }> } }>;
  tracks: Array<{ id: string; label: string }>;
  bounds: { x: number; y: number; width: number; height: number };
};

export function GraphSurface({ snapshot }: { snapshot: GraphSnapshot }) {
  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  return <svg className="graph-surface" viewBox={`${snapshot.bounds.x} ${snapshot.bounds.y} ${snapshot.bounds.width} ${snapshot.bounds.height}`} role="img" aria-label="工作流审阅图">
    {snapshot.edges.map((edge) => {
      const points = edge.route?.points ?? [];
      const source = nodeById.get(edge.source); const target = nodeById.get(edge.target);
      if (!source || !target || points.length < 2) return null;
      return <g key={edge.id} className="graph-edge"><polyline points={points.map((point) => `${point.x},${point.y}`).join(" ")} /><title>{edge.label ?? `${source.label} → ${target.label}`}</title></g>;
    })}
    {snapshot.nodes.map((node) => <g key={node.id} className="graph-node" transform={`translate(${node.bounds.x} ${node.bounds.y})`}><rect width={node.bounds.width} height={node.bounds.height} rx="8" /><text x="14" y="30">{node.label}</text><text className="graph-node-kind" x="14" y="51">{node.kind}</text></g>)}
  </svg>;
}
