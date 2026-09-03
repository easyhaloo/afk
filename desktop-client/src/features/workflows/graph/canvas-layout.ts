import type { CanvasTemplateNode } from "../../../../shared/ipc-contract";

export const CANVAS_NODE_WIDTH = 164;
export const CANVAS_NODE_HEIGHT = 94;
export const CANVAS_WORLD_WIDTH = 1500;
export const CANVAS_WORLD_HEIGHT = 640;
export const CANVAS_MARGIN = 22;

const START_X = 220;
const START_Y = 74;
const COLUMN_GAP = 190;
const ROW_GAP = 154;
const MAX_COLUMNS = 4;

export function clampCanvasPosition(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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
