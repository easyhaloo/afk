import type { GraphDiagnostic, GraphSnapshot, Rect } from './ir.js';

function contains(outer: Rect, inner: Rect): boolean { return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height; }

export function validateSnapshot(snapshot: GraphSnapshot): readonly GraphDiagnostic[] {
  const diagnostics: GraphDiagnostic[] = [...snapshot.diagnostics];
  const nodeIds = new Set<string>();
  for (const node of snapshot.nodes) {
    if (nodeIds.has(node.id)) diagnostics.push({ severity: 'error', code: 'invalid-snapshot', stepId: node.stepId, message: `Duplicate node id: ${node.id}` });
    nodeIds.add(node.id);
    if (!contains(snapshot.bounds, node.bounds)) diagnostics.push({ severity: 'error', code: 'invalid-snapshot', stepId: node.stepId, message: `Node outside graph bounds: ${node.id}` });
  }
  const edgeIds = new Set<string>();
  for (const edge of snapshot.edges) {
    if (edgeIds.has(edge.id)) diagnostics.push({ severity: 'error', code: 'invalid-snapshot', edgeId: edge.id, message: `Duplicate edge id: ${edge.id}` });
    edgeIds.add(edge.id);
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) diagnostics.push({ severity: 'error', code: 'invalid-snapshot', edgeId: edge.id, message: `Edge has a missing endpoint: ${edge.id}` });
    if (!edge.route) diagnostics.push({ severity: 'error', code: 'geometry/no-route', edgeId: edge.id, message: `Edge has no route: ${edge.id}` });
  }
  return diagnostics;
}
