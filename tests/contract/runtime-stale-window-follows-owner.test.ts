import { describe, expect, it, vi } from "vitest";

/**
 * "How long until a run is stale?" is one question. The application
 * package answers it, the board answers it, and the desktop answers it.
 * The board and the desktop each had their own copy of the window.
 *
 * This test shrinks the window the application package publishes and then
 * asks the board whether it shrank with it. A board that keeps its own
 * copy calls a run stale on a schedule the runtime does not, and the two
 * disagree about the same run.
 */
vi.mock("@afk/application", async importOriginal => {
  const original = await importOriginal<typeof import("@afk/application")>();
  return {
    ...original,
    RUNTIME_STALE_AFTER_MS: 1_000,
  };
});

import { projectWorkItems } from "../../src/views/board/data/work-item-projection";

describe("the board's staleness window", () => {
  it("is the window the application package publishes", () => {
    const now = Date.parse("2026-09-15T00:10:00.000Z");
    const projected = projectWorkItems({
      backlogs: [],
      active: [{
        runId: "run-1",
        workItemId: "github:acme/api#42",
        status: "running",
        phase: "implementing",
        heartbeatAt: "2026-09-15T00:09:58.000Z",
        startedAt: "2026-09-15T00:09:00.000Z",
      }],
      now,
    } as never);

    // Two seconds of silence: stale under the window the application
    // published, alive under the five minutes the board used to carry.
    expect(projected[0]?.runStatus).toBe("stale");
  });
});
