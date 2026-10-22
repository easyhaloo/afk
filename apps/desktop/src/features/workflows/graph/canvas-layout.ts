import type { CanvasTemplateNode } from "../../../../shared/ipc-contract.js";

export const CANVAS_NODE_WIDTH = 200;
export const CANVAS_NODE_HEIGHT = 120;
export const CANVAS_WORLD_WIDTH = 1500;
export const CANVAS_WORLD_HEIGHT = 640;
export const CANVAS_MARGIN = 22;

export type CanvasViewport = { x: number; y: number; scale: number };
export type CanvasPoint = { x: number; y: number };

const START_X = 292;
const START_Y = 74;
const COLUMN_GAP = 244;
const ROW_GAP = 154;
const MAX_COLUMNS = 4;

export function clampCanvasPosition(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function zoomCanvasViewportAtPoint(viewport: CanvasViewport, pointer: CanvasPoint, requestedScale: number): CanvasViewport {
  const scale = clampCanvasPosition(requestedScale, 0.1, 1.35);
  const worldX = (pointer.x - viewport.x) / viewport.scale;
  const worldY = (pointer.y - viewport.y) / viewport.scale;
  return {
    x: pointer.x - worldX * scale,
    y: pointer.y - worldY * scale,
    scale,
  };
}

export function fitCanvasViewport(nodes: readonly CanvasPoint[], size: { width: number; height: number }): CanvasViewport {
  if (!nodes.length) return { x: 0, y: 0, scale: 1 };
  const minX = Math.min(...nodes.map(node => node.x)) - 16;
  const minY = Math.min(...nodes.map(node => node.y)) - 70;
  const width = Math.max(...nodes.map(node => node.x + CANVAS_NODE_WIDTH)) + 16 - minX;
  const height = Math.max(...nodes.map(node => node.y + CANVAS_NODE_HEIGHT)) + 24 - minY;
  const scale = Math.max(.1, Math.min(1, (size.width - 32) / width, (size.height - 100) / height));
  return { scale, x: (size.width - width * scale) / 2 - minX * scale, y: (size.height - 60 - height * scale) / 2 - minY * scale };
}

export function layoutCanvasNodes(nodes: readonly CanvasTemplateNode[]): CanvasTemplateNode[] {
  const maxX = CANVAS_WORLD_WIDTH - CANVAS_NODE_WIDTH - CANVAS_MARGIN;
  const maxY = CANVAS_WORLD_HEIGHT - CANVAS_NODE_HEIGHT - CANVAS_MARGIN;
  const columns = Math.min(MAX_COLUMNS, Math.max(1, Math.floor((maxX - START_X) / COLUMN_GAP) + 1));

  return nodes.map((node, index) => ({
    ...node,
    x: clampCanvasPosition(START_X + (index % columns) * COLUMN_GAP, CANVAS_MARGIN, maxX),
    y: clampCanvasPosition(START_Y + Math.floor(index / columns) * ROW_GAP, CANVAS_MARGIN, maxY),
  }));
}

export function insertCanvasNodeAfter(nodes: readonly CanvasTemplateNode[], selectedId: string, next: CanvasTemplateNode): CanvasTemplateNode[] {
  const selectedIndex = selectedId === "start" ? -1 : nodes.findIndex((node) => node.id === selectedId);
  const insertIndex = selectedId === "start" ? 0 : selectedIndex >= 0 ? selectedIndex + 1 : nodes.length;
  return [...nodes.slice(0, insertIndex), next, ...nodes.slice(insertIndex)];
}

export function canvasNodesOverlap(left: CanvasTemplateNode, right: CanvasTemplateNode) {
  return left.x < right.x + CANVAS_NODE_WIDTH
    && left.x + CANVAS_NODE_WIDTH > right.x
    && left.y < right.y + CANVAS_NODE_HEIGHT
    && left.y + CANVAS_NODE_HEIGHT > right.y;
}

export function hasCanvasNodeCollisions(nodes: readonly CanvasTemplateNode[]) {
  for (let index = 0; index < nodes.length; index += 1) {
    for (let other = index + 1; other < nodes.length; other += 1) {
      if (canvasNodesOverlap(nodes[index], nodes[other])) return true;
    }
  }
  return false;
}
