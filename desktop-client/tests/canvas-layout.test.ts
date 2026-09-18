import { describe, expect, it } from "vitest";
import { hasCanvasNodeCollisions, insertCanvasNodeAfter, layoutCanvasNodes, zoomCanvasViewportAtPoint } from "../src/features/workflows/graph/canvas-layout";

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
  it("keeps the world point under the pointer stable while zooming", () => {
    const viewport = { x: 120, y: 80, scale: 1 };
    const pointer = { x: 420, y: 280 };

    const result = zoomCanvasViewportAtPoint(viewport, pointer, 1.25);

    expect((pointer.x - result.x) / result.scale).toBeCloseTo((pointer.x - viewport.x) / viewport.scale);
    expect((pointer.y - result.y) / result.scale).toBeCloseTo((pointer.y - viewport.y) / viewport.scale);
    expect(result.scale).toBe(1.25);
  });

  it("clamps pointer-centered zoom to the supported range", () => {
    expect(zoomCanvasViewportAtPoint({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 2).scale).toBe(1.35);
    expect(zoomCanvasViewportAtPoint({ x: 0, y: 0, scale: 1 }, { x: 0, y: 0 }, 0.2).scale).toBe(0.7);
  });

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

  it("inserts a new node immediately after the selected node", () => {
    const existing = nodes(3);
    const next = { ...nodes(1)[0], id: "qa-1", template: "qa" as const, label: "审查 Agent" };

    expect(insertCanvasNodeAfter(existing, "agent-2", next).map((node) => node.id)).toEqual(["agent-1", "agent-2", "qa-1", "agent-3"]);
  });

  it("inserts at the beginning when the workflow start is selected", () => {
    const existing = nodes(2);
    const next = { ...nodes(1)[0], id: "qa-1", template: "qa" as const, label: "审查 Agent" };

    expect(insertCanvasNodeAfter(existing, "start", next).map((node) => node.id)).toEqual(["qa-1", "agent-1", "agent-2"]);
  });

  it("appends when the selected node is not in the custom workflow", () => {
    const existing = nodes(2);
    const next = { ...nodes(1)[0], id: "qa-1", template: "qa" as const, label: "审查 Agent" };

    expect(insertCanvasNodeAfter(existing, "step-built-in", next).map((node) => node.id)).toEqual(["agent-1", "agent-2", "qa-1"]);
  });

  it("recognizes persisted collisions", () => {
    expect(hasCanvasNodeCollisions(nodes(2))).toBe(true);
  });
});
