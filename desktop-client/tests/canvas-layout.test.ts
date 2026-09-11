import { describe, expect, it } from "vitest";
import { hasCanvasNodeCollisions, layoutCanvasNodes } from "../src/features/workflows/graph/canvas-layout";

const nodes = (count: number) => Array.from({ length: count }, (_, index) => ({
  id: `agent-${index + 1}`,
  template: "agent" as const,
  label: `Agent ${index + 1}`,
  description: "",
  prompt: "",
  x: 770,
  y: 356,
}));

describe("custom workflow canvas layout", () => {
  it("places a long workflow in rows without overlapping nodes", () => {
    const result = layoutCanvasNodes(nodes(12));

    expect(result).toHaveLength(12);
    expect(result.every(node => node.x >= 22 && node.y >= 22 && node.x + 164 <= 1478 && node.y + 94 <= 618)).toBe(true);
    expect(hasCanvasNodeCollisions(result)).toBe(false);
  });

  it("is deterministic and preserves the input order", () => {
    const first = layoutCanvasNodes(nodes(8));
    const second = layoutCanvasNodes(nodes(8));
    expect(second.map(node => ({ id: node.id, x: node.x, y: node.y }))).toEqual(first.map(node => ({ id: node.id, x: node.x, y: node.y })));
  });

  it("recognizes persisted collisions", () => {
    expect(hasCanvasNodeCollisions(nodes(2))).toBe(true);
  });
});
