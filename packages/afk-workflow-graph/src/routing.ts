import type { GraphNode, GraphSnapshot, OrthogonalRoute, Point, Rect } from './ir.js';

function centerY(rect: Rect): number { return rect.y + rect.height / 2; }
function intersects(a: Point, b: Point, rect: Rect): boolean {
  if (a.x === b.x) {
    const y1 = Math.min(a.y, b.y); const y2 = Math.max(a.y, b.y);
    return a.x > rect.x && a.x < rect.x + rect.width && y2 > rect.y && y1 < rect.y + rect.height;
  }
  const x1 = Math.min(a.x, b.x); const x2 = Math.max(a.x, b.x);
  return a.y > rect.y && a.y < rect.y + rect.height && x2 > rect.x && x1 < rect.x + rect.width;
}

export function routeBetween(source: GraphNode, target: GraphNode, obstacles: readonly Rect[] = [], trackGap = 48): OrthogonalRoute | undefined {
  const start = { x: source.bounds.x + source.bounds.width, y: centerY(source.bounds) };
  const end = { x: target.bounds.x, y: centerY(target.bounds) };
  const midX = Math.max(start.x + trackGap / 2, (start.x + end.x) / 2);
  const points: Point[] = start.x <= end.x ? [start, { x: midX, y: start.y }, { x: midX, y: end.y }, end] : [start, { x: start.x + trackGap, y: start.y }, { x: start.x + trackGap, y: end.y }, end];
  for (let index = 0; index < points.length - 1; index += 1) {
    if (obstacles.some((obstacle) => obstacle !== source.bounds && obstacle !== target.bounds && intersects(points[index], points[index + 1], obstacle))) return undefined;
  }
  const segments = points.slice(0, -1).map((from, index) => {
    const to = points[index + 1];
    return from.y === to.y ? { kind: 'horizontal' as const, from, to } : { kind: 'vertical' as const, from, to };
  });
  return { points, segments };
}

export function routeEdges(snapshot: GraphSnapshot, options: { readonly trackGap?: number } = {}): GraphSnapshot {
  const byId = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const edges = snapshot.edges.map((edge) => {
    const source = byId.get(edge.source); const target = byId.get(edge.target);
    if (!source || !target) return edge;
    const route = routeBetween(source, target, snapshot.nodes.map((node) => node.bounds), options.trackGap);
    return route ? { ...edge, route } : edge;
  });
  const diagnostics = edges.filter((edge) => !edge.route).map((edge) => ({ severity: 'error' as const, code: 'geometry/no-route' as const, edgeId: edge.id, message: `No route available for edge ${edge.id}` }));
  return { ...snapshot, edges, diagnostics: [...snapshot.diagnostics, ...diagnostics] };
}
