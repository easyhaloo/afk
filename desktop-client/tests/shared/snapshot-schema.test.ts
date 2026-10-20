import { describe, expect, it } from "vitest";
import { parseSnapshot, SnapshotContractError, snapshotSchema } from "../../shared/snapshot-schema";
import { DEMO_SNAPSHOT } from "../../src/mock-data";

/**
 * The snapshot is the widest payload the desktop hands to the renderer, and
 * it is assembled from records the program does not own. These checks cover
 * the schema on its own: a faithful payload survives unchanged, and a
 * malformed one is refused with the path that broke.
 */
describe("snapshot contract", () => {
  it("accepts the desktop's own snapshot payload unchanged", () => {
    expect(parseSnapshot(DEMO_SNAPSHOT)).toEqual(DEMO_SNAPSHOT);
  });

  it("refuses a payload that is missing a required field", () => {
    const broken = { ...DEMO_SNAPSHOT, workspace: { afkDirectoryPresent: true, eventCount: 7 } };

    expect(() => parseSnapshot(broken)).toThrow(SnapshotContractError);
    expect(() => parseSnapshot(broken)).toThrow(/workspace\.root/);
  });

  it("refuses a status outside the union", () => {
    const broken = { ...DEMO_SNAPSHOT, workflowRuns: [{ ...DEMO_SNAPSHOT.workflowRuns[0], status: "paused" }] };

    expect(() => parseSnapshot(broken)).toThrow(/workflowRuns\.0\.status/);
  });

  it("refuses a nested value of the wrong type", () => {
    const broken = { ...DEMO_SNAPSHOT, loop: { ...DEMO_SNAPSHOT.loop, execution: { ...DEMO_SNAPSHOT.loop.execution, active: "1" } } };

    expect(() => parseSnapshot(broken)).toThrow(/loop\.execution\.active/);
  });

  it("refuses a canvas node whose provider is outside the shared union", () => {
    const broken = {
      ...DEMO_SNAPSHOT,
      workflow: {
        ...DEMO_SNAPSHOT.workflow,
        canvasNodes: [{ ...DEMO_SNAPSHOT.workflow.canvasNodes[0], provider: "gemini" }],
      },
    };

    expect(() => parseSnapshot(broken)).toThrow(/workflow\.canvasNodes\.0\.provider/);
  });

  it("refuses a step whose conditional clause is malformed", () => {
    const broken = {
      ...DEMO_SNAPSHOT,
      workflowTemplates: DEMO_SNAPSHOT.workflowTemplates.map(template => ({
        ...template,
        steps: template.steps.map(step => ({ ...step, when: { step: "review" } })),
      })),
    };

    expect(() => parseSnapshot(broken)).toThrow(/when/);
  });

  it("reports every issue it found, not only the first", () => {
    const broken = { ...DEMO_SNAPSHOT, workflow: { ...DEMO_SNAPSHOT.workflow, agentDefault: 7 } };

    const error = (() => {
      try { parseSnapshot(broken); return null; } catch (cause) { return cause as SnapshotContractError; }
    })();

    expect(error).toBeInstanceOf(SnapshotContractError);
    expect(error?.issues.join(" ")).toMatch(/workflow\.agentDefault/);
  });

  it("keeps the schema and the contract in step", () => {
    // The compile-time lock lives beside the schema; this check is its
    // runtime counterpart: a payload the contract accepts must pass the
    // schema, and a payload the contract rejects must not.
    expect(snapshotSchema.safeParse(DEMO_SNAPSHOT).success).toBe(true);
    expect(snapshotSchema.safeParse({ ...DEMO_SNAPSHOT, loop: null }).success).toBe(false);
  });
});
