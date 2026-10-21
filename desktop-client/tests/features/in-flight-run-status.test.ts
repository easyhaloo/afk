import { describe, expect, it, vi } from "vitest";

/**
 * "Is this run still going?" is one question, and the desktop asks it in
 * three places: whether a second run may start, what the board offers to
 * do, and whether the page keeps polling. Each of them used to write the
 * two names down.
 *
 * This test grows the set of states that mean a run is in flight and then
 * asks the desktop whether it grew with it. A reader that keeps its own
 * copy does not know about the new state, and the board would offer to
 * start a work item that is already running.
 */
vi.mock("../../shared/backlog-contract", async importOriginal => {
  const original = await importOriginal<typeof import("../../shared/backlog-contract")>();
  const inFlight = [...original.WORK_ITEM_RUN_STATUSES_IN_FLIGHT, "paused"];
  return {
    ...original,
    WORK_ITEM_RUN_STATUSES_IN_FLIGHT: inFlight,
    isWorkItemRunInFlight: (status: string) => inFlight.includes(status as never),
  };
});

import { WORK_ITEM_RUN_STATUSES_IN_FLIGHT } from "../../shared/backlog-contract";
import { getBacklogPrimaryAction } from "../../src/features/backlog/backlog-primary-action";
import type { BacklogItem } from "../../shared/backlog-contract";

function item(overrides: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id: "42",
    title: "demo",
    description: "demo",
    dependsOn: [],
    state: "ready",
    executionMode: "afk",
    tags: [],
    branchName: "afk/backlog-42",
    providerRef: "stub:42",
    ...overrides,
  } as BacklogItem;
}

describe("the desktop knows which runs are still going", () => {
  it("offers to show a run that is still going, not to start one", () => {
    for (const status of WORK_ITEM_RUN_STATUSES_IN_FLIGHT) {
      const action = getBacklogPrimaryAction(item(), {
        backlogId: "42",
        backlog: item(),
        activeRun: { id: "run-1", backlogId: "42", status, startedAt: "2026-09-15T00:00:00.000Z" },
      });
      expect(action).not.toBe("start");
    }
  });

  it("offers to start a work item whose run has finished", () => {
    const action = getBacklogPrimaryAction(item(), {
      backlogId: "42",
      backlog: item(),
      activeRun: { id: "run-1", backlogId: "42", status: "completed", startedAt: "2026-09-15T00:00:00.000Z" },
    });
    expect(action).toBe("start");
  });
});
